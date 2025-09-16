const { pool } = require('../services/database');

// Lógica para criar um formulário, suas perguntas e opções em uma única transação
exports.createFullForm = async (req, res) => {
  const { title, description, questions } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Inicia a transação

    // 1. Insere o formulário
    const formResult = await client.query(
      'INSERT INTO forms (title, description) VALUES ($1, $2) RETURNING form_id',
      [title, description]
    );
    const formId = formResult.rows[0].form_id;

    // 2. Itera sobre as perguntas e as insere
    for (const q of questions) {
      const questionResult = await client.query(
        'INSERT INTO questions (form_id, question_text, question_type, display_order) VALUES ($1, $2, $3, $4) RETURNING question_id',
        [formId, q.text, q.type, q.order]
      );
      const questionId = questionResult.rows[0].question_id;

      // 3. Itera sobre as opções da pergunta e as insere
      if (q.options) {
        for (const opt of q.options) {
          await client.query(
            'INSERT INTO options (question_id, option_text, response_limit) VALUES ($1, $2, $3)',
            [questionId, opt.text, opt.limit || null]
          );
        }
      }
    }

    await client.query('COMMIT'); // Confirma a transação
    res.status(201).json({ message: 'Formulário criado com sucesso!', formId });
  } catch (error) {
    await client.query('ROLLBACK'); // Desfaz tudo em caso de erro
    console.error('Erro ao criar formulário:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  } finally {
    client.release(); // Libera a conexão
  }
};

// Lógica para buscar um formulário e o estado atual de suas opções
exports.getFormWithDetails = async (req, res) => {
    const { id } = req.params;
    try {
        // Busca o formulário, perguntas e opções
        const formQuery = 'SELECT * FROM forms WHERE form_id = $1';
        const questionsQuery = `
            SELECT q.*, 
                   json_agg(
                       json_build_object(
                           'option_id', o.option_id, 
                           'text', o.option_text, 
                           'limit', o.response_limit
                       )
                   ) as options
            FROM questions q
            LEFT JOIN options o ON q.question_id = o.question_id
            WHERE q.form_id = $1
            GROUP BY q.question_id
            ORDER BY q.display_order;
        `;
        // Busca a contagem de respostas para cada opção
        const countsQuery = `
            SELECT option_id, COUNT(*) as response_count 
            FROM submissions 
            WHERE form_id = $1 
            GROUP BY option_id;
        `;

        const formRes = await pool.query(formQuery, [id]);
        if (formRes.rows.length === 0) {
            return res.status(404).json({ error: 'Formulário não encontrado' });
        }

        const questionsRes = await pool.query(questionsQuery, [id]);
        const countsRes = await pool.query(countsQuery, [id]);

        const responseCounts = countsRes.rows.reduce((acc, row) => {
            acc[row.option_id] = parseInt(row.response_count, 10);
            return acc;
        }, {});

        // Adiciona a contagem e o status de "esgotado" às opções
        const questionsWithCounts = questionsRes.rows.map(q => ({
            ...q,
            options: q.options.map(opt => ({
                ...opt,
                response_count: responseCounts[opt.option_id] || 0,
                is_exhausted: opt.limit !== null && (responseCounts[opt.option_id] || 0) >= opt.limit
            }))
        }));

        const result = {
            ...formRes.rows[0],
            questions: questionsWithCounts
        };

        res.status(200).json(result);
    } catch (error) {
        console.error('Erro ao buscar formulário:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
};


// Lógica para submeter uma resposta (versão simplificada sem Redis por enquanto)
exports.submitResponse = async (req, res) => {
    const formId = req.params.id;
    const { question_id, option_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verifica o limite e a contagem atual (com lock para segurança)
        const optionCheck = await client.query(
            'SELECT response_limit FROM options WHERE option_id = $1 FOR UPDATE', 
            [option_id]
        );
        const limit = optionCheck.rows[0]?.response_limit;

        if (limit !== null) {
            const countCheck = await client.query(
                'SELECT COUNT(*) as current_count FROM submissions WHERE option_id = $1', 
                [option_id]
            );
            const currentCount = parseInt(countCheck.rows[0].current_count, 10);

            if (currentCount >= limit) {
                throw new Error('Opção esgotada.');
            }
        }

        // 2. Insere a nova resposta
        await client.query(
            'INSERT INTO submissions (form_id, question_id, option_id) VALUES ($1, $2, $3)',
            [formId, question_id, option_id]
        );

        await client.query('COMMIT');
        res.status(201).json({ message: 'Resposta enviada com sucesso!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Erro ao enviar resposta:', error.message);
        if (error.message === 'Opção esgotada.') {
            res.status(409).json({ error: 'Esta opção não está mais disponível.' });
        } else {
            res.status(500).json({ error: 'Erro interno do servidor' });
        }
    } finally {
        client.release();
    }
};
