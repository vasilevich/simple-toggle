const TABLE = 'bot_condition_mapper';
const engine = require('./rules_engine');

module.exports = ({app, knex, verify_request, generateRandomToken, getBaseUrl, history = null}) => {
    const schemaReady = (async () => {
        if (await knex.schema.hasTable(TABLE)) return;
        await knex.schema.createTable(TABLE, table => {
            table.increments('id').primary();
            table.string('key', 255).notNullable().index();
            table.text('title');
            table.text('description');
            table.text('token').notNullable().unique();
            table.text('example_json').notNullable();
            table.text('rules_json').notNullable();
            table.dateTime('updated_at').notNullable();
            table.dateTime('created_at').notNullable();
        });
    })();
    schemaReady.catch(err => console.error(`Unable to initialize ${TABLE}:`, err.message));

    const parseJson = (value, fallback) => {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
    };

    const normalizeExample = example => {
        const value = parseJson(example, {});
        if (!engine.isPlainObject(value)) throw new TypeError('example must be a JSON object.');
        return value;
    };

    const revisionFor = row => `${new Date(row.updated_at || row.created_at || 0).getTime()}-${String(row.token || '').slice(0, 8)}`;
    const etagFor = row => `"mapper-${revisionFor(row)}"`;

    const setDefinitionHeaders = (req, res, row) => {
        const etag = etagFor(row);
        res.set('ETag', etag);
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        if (row.updated_at) res.set('Last-Modified', new Date(row.updated_at).toUTCString());
        if (req.get('if-none-match') === etag) {
            res.status(304).end();
            return false;
        }
        return true;
    };

    const serializeRow = (req, row) => ({
        definitionVersion: 2,
        revision: revisionFor(row),
        key: row.key,
        title: row.title || '',
        description: row.description || '',
        token: row.token,
        accessToken: row.token,
        definitionUrl: `${getBaseUrl(req)}/m/${encodeURIComponent(row.token)}`,
        definitionKeyUrl: `${getBaseUrl(req)}/m/key/${encodeURIComponent(row.key)}`,
        runtimeUrl: `${getBaseUrl(req)}/m/${encodeURIComponent(row.token)}`,
        example: normalizeExample(parseJson(row.example_json, {})),
        rules: engine.normalizeRules(parseJson(row.rules_json, [])),
        updatedAt: row.updated_at,
        createdAt: row.created_at
    });

    const mapperUpdate = body => {
        const update = {updated_at: new Date()};
        if (body.key !== undefined) {
            const key = String(body.key).trim();
            if (!key) throw new TypeError('key is required.');
            update.key = key;
        }
        if (body.title !== undefined) update.title = String(body.title ?? '');
        if (body.description !== undefined) update.description = String(body.description ?? '');
        if (body.example !== undefined || body.example_json !== undefined) update.example_json = JSON.stringify(normalizeExample(body.example ?? body.example_json));
        if (body.rules !== undefined || body.rules_json !== undefined) update.rules_json = JSON.stringify(engine.normalizeRules(parseJson(body.rules ?? body.rules_json, [])));
        return update;
    };

    const sendDefinition = async (req, res, row) => {
        if (!row) return res.status(404).json({error: 'Condition mapper not found.'});
        if (!setDefinitionHeaders(req, res, row)) return;
        res.json(serializeRow(req, row));
    };

    app.get('/bot/mappers', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const rows = await knex(TABLE).select('*').orderBy('created_at', 'desc');
            res.json(rows.map(row => serializeRow(req, row)));
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve condition mappers.'});
        }
    });

    app.post('/bot/mappers', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const key = String(req.body?.key ?? '').trim();
            if (!key) return res.status(400).json({error: 'key is required.'});
            const now = new Date();
            const row = {
                key,
                title: String(req.body?.title ?? ''),
                description: String(req.body?.description ?? ''),
                token: await generateRandomToken(),
                example_json: JSON.stringify(normalizeExample(req.body?.example ?? {})),
                rules_json: JSON.stringify(engine.normalizeRules(req.body?.rules ?? [])),
                updated_at: now,
                created_at: now
            };
            await knex(TABLE).insert(row);
            if (history) await history.record('mapper', row.token, 'create', null, row, 'api');
            res.status(201).json(serializeRow(req, row));
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to create condition mapper.'});
        }
    });

    app.get('/bot/mappers/:token', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            await sendDefinition(req, res, await knex(TABLE).where('token', req.params.token).first());
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve condition mapper.'});
        }
    });

    const updateHandler = async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const existing = await knex(TABLE).where('token', req.params.token).first();
            if (!existing) return res.status(404).json({error: 'Condition mapper not found.'});
            const update = mapperUpdate(req.body || {});
            await knex(TABLE).where('token', req.params.token).update(update);
            const row = {...existing, ...update};
            if (history) await history.record('mapper', req.params.token, 'update', existing, row, 'api');
            res.json(serializeRow(req, row));
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to update condition mapper.'});
        }
    };
    app.post('/bot/mappers/:token', updateHandler);
    app.put('/bot/mappers/:token', updateHandler);

    app.delete('/bot/mappers/:token', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const existing = await knex(TABLE).where('token', req.params.token).first();
            if (!existing) return res.status(404).json({error: 'Condition mapper not found.'});
            await knex.transaction(async trx => {
                await trx(TABLE).where('token', req.params.token).del();
                if (history) await history.record('mapper', req.params.token, 'delete', existing, null, 'api', trx);
            });
            res.json({status: 'success'});
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to delete condition mapper.'});
        }
    });

    // Public configuration distribution endpoints. These return definitions only; production row evaluation belongs in clients.
    app.get('/m/key/:key', async (req, res) => {
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        try {
            await schemaReady;
            const row = await knex(TABLE).where('key', req.params.key).orderBy('created_at', 'desc').first();
            await sendDefinition(req, res, row);
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve mapper definition.'});
        }
    });

    app.get('/m/:token', async (req, res) => {
        try {
            await schemaReady;
            await sendDefinition(req, res, await knex(TABLE).where('token', req.params.token).first());
        } catch (err) {
            console.error(err);
            res.status(500).json({error: 'Unable to retrieve mapper definition.'});
        }
    });

    // Server-side evaluation remains only as a debugging/testing convenience.
    app.post('/bot/mappers/:token/test', async (req, res) => {
        if (!verify_request(req, res)) return;
        try {
            await schemaReady;
            const row = await knex(TABLE).where('token', req.params.token).first();
            if (!row) return res.status(404).json({error: 'Condition mapper not found.'});
            const input = req.body ?? {};
            if (!engine.isPlainObject(input)) return res.status(400).json({error: 'Input must be a JSON object.'});
            res.json(engine.evaluateRules(parseJson(row.rules_json, []), input));
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to test condition mapper.'});
        }
    });

    app.post('/m/:token', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await schemaReady;
            const row = await knex(TABLE).where('token', req.params.token).first();
            if (!row) return res.status(404).json({error: 'Invalid mapper access token.'});
            const input = req.body ?? {};
            if (!engine.isPlainObject(input)) return res.status(400).json({error: 'Input must be a JSON object.'});
            const evaluation = engine.evaluateRules(parseJson(row.rules_json, []), input);
            if (req.query.meta === 'true') return res.json(evaluation);
            res.json(req.query.merge === 'true' ? evaluation.output : evaluation.result);
        } catch (err) {
            console.error(err);
            res.status(err instanceof TypeError ? 400 : 500).json({error: err.message || 'Unable to evaluate condition mapper.'});
        }
    });

    return {
        schemaReady,
        evaluateRules: engine.evaluateRules,
        evaluateExpression: engine.evaluateExpression,
        normalizeRules: engine.normalizeRules,
        normalizeExpression: engine.normalizeExpression,
        normalizeCondition: engine.normalizeCondition,
        normalizeExample,
        serializeRow
    };
};
