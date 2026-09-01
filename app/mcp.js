const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StreamableHTTPServerTransport} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {z} = require('zod');

module.exports = ({app, knex, history, mapperApi, generateRandomToken, configuredUrl = '', temporaryLinkTable = 'bot_temporary_value_link'}) => {
    const parseJson = (value, fallback) => {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return fallback; }
    };
    const valueForDb = value => typeof value === 'string' ? value : JSON.stringify(value);
    const result = data => ({content: [{type: 'text', text: JSON.stringify(data, null, 2)}], structuredContent: data});
    const safe = fn => async args => {
        try { return result(await fn(args || {})); }
        catch (err) { return {isError: true, content: [{type: 'text', text: err.message || String(err)}]}; }
    };

    const mapperRow = row => history.snapshot('mapper', row);
    const toggleRow = row => history.snapshot('toggle', row);
    const valueRow = row => history.snapshot('value', row);

    async function findControl(type, id) {
        const needle = String(id || '').trim();
        if (!needle) throw new Error('id is required.');
        if (type === 'toggle') {
            const row = await knex('bot_control').where('bot_name', needle).first();
            return row ? toggleRow(row) : null;
        }
        if (type === 'value') {
            let row = await knex('bot_single_value_control').where('token', needle).first();
            if (!row) row = await knex('bot_single_value_control').where('key', needle).orderBy('created_at', 'desc').first();
            return row ? valueRow(row) : null;
        }
        if (type === 'mapper') {
            await mapperApi.schemaReady;
            let row = await knex('bot_condition_mapper').where('token', needle).first();
            if (!row) row = await knex('bot_condition_mapper').where('key', needle).orderBy('created_at', 'desc').first();
            return row ? mapperRow(row) : null;
        }
        throw new Error(`Unknown control type: ${type}`);
    }

    async function listControls(type = null) {
        const output = [];
        if (!type || type === 'toggle') {
            const rows = await knex('bot_control').select('*').orderBy('bot_name');
            output.push(...rows.map(row => ({type: 'toggle', ...toggleRow(row)})));
        }
        if (!type || type === 'value') {
            const rows = await knex('bot_single_value_control').select('*').orderBy('created_at', 'desc');
            output.push(...rows.map(row => ({type: 'value', ...valueRow(row)})));
        }
        if (!type || type === 'mapper') {
            await mapperApi.schemaReady;
            const rows = await knex('bot_condition_mapper').select('*').orderBy('created_at', 'desc');
            output.push(...rows.map(row => ({type: 'mapper', ...mapperRow(row)})));
        }
        return output;
    }

    const summarizeNode = node => {
        if (!node) return '(always)';
        if (node.type === 'condition') {
            const labels = {eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', starts_with: 'starts with', ends_with: 'ends with', in: 'in', not_in: 'not in', exists: 'exists', empty: 'is empty', not_empty: 'is not empty'};
            const unary = ['exists', 'empty', 'not_empty'].includes(node.operator);
            return `${node.field} ${labels[node.operator] || node.operator}${unary ? '' : ` ${JSON.stringify(node.value)}`}`;
        }
        const children = node.children || [];
        if (!children.length) return '(always)';
        return children.map(child => child.type === 'group' ? `(${summarizeNode(child)})` : summarizeNode(child)).join(node.op === 'or' ? ' OR ' : ' AND ');
    };

    function explanation(type, control) {
        if (!control) return null;
        if (type === 'toggle') return `${control.title || control.botName} (${control.botName}) is currently ${control.status ? 'enabled' : 'disabled'}. ${control.description || 'No description is stored.'}`;
        if (type === 'value') return `${control.key} is currently ${JSON.stringify(control.value)}${control.botName && control.botName !== 'none' ? ` for ${control.botName}` : ''}. ${control.description || 'No description is stored.'}`;
        const rules = (control.rules || []).map((rule, index) => `${index + 1}. ${rule.name || `Rule ${index + 1}`}: ${summarizeNode(rule.when)} => ${JSON.stringify(rule.result || {})}`).join('\n');
        return `${control.title || control.key} (${control.key}) is a first-match condition mapper with ${(control.rules || []).length} rules. ${control.description || 'No description is stored.'}${rules ? `\n${rules}` : ''}`;
    }

    async function createControl(args) {
        const now = new Date();
        if (args.type === 'toggle') {
            const botName = String(args.key || '').trim();
            if (!botName) throw new Error('key is required for a toggle.');
            if (await knex('bot_control').where('bot_name', botName).first()) throw new Error(`Toggle ${botName} already exists.`);
            const row = {bot_name: botName, title: String(args.title || botName), description: String(args.description || ''), status: args.status ? 1 : 0, updated_at: now, created_at: now};
            await knex('bot_control').insert(row);
            await history.record('toggle', botName, 'create', null, row, 'mcp');
            return {type: 'toggle', ...toggleRow(row)};
        }
        if (args.type === 'value') {
            const key = String(args.key || '').trim();
            if (!key) throw new Error('key is required for a value.');
            const row = {key, value: valueForDb(args.value ?? ''), description: String(args.description || ''), status: args.status ? 1 : 0, token: await generateRandomToken(), bot_name: String(args.bot_name || 'none'), updated_at: now, created_at: now};
            await knex('bot_single_value_control').insert(row);
            await history.record('value', row.token, 'create', null, row, 'mcp');
            return {type: 'value', ...valueRow(row)};
        }
        if (args.type === 'mapper') {
            await mapperApi.schemaReady;
            const key = String(args.key || '').trim();
            if (!key) throw new Error('key is required for a mapper.');
            const row = {key, title: String(args.title || ''), description: String(args.description || ''), token: await generateRandomToken(), example_json: JSON.stringify(mapperApi.normalizeExample(args.example || {})), rules_json: JSON.stringify(mapperApi.normalizeRules(args.rules || [])), updated_at: now, created_at: now};
            await knex('bot_condition_mapper').insert(row);
            await history.record('mapper', row.token, 'create', null, row, 'mcp');
            return {type: 'mapper', ...mapperRow(row)};
        }
        throw new Error(`Unknown control type: ${args.type}`);
    }

    async function updateControl({type, id, patch}) {
        const existing = await findControl(type, id);
        if (!existing) throw new Error(`${type} control not found: ${id}`);
        const now = new Date();
        if (type === 'toggle') {
            const update = {updated_at: now};
            if (patch.title !== undefined) update.title = String(patch.title ?? '');
            if (patch.description !== undefined) update.description = String(patch.description ?? '');
            if (patch.status !== undefined || patch.enabled !== undefined) update.status = (patch.status ?? patch.enabled) ? 1 : 0;
            await knex('bot_control').where('bot_name', existing.botName).update(update);
            const after = await findControl(type, existing.botName);
            await history.record(type, existing.botName, 'update', existing, after, 'mcp');
            return {type, ...after};
        }
        if (type === 'value') {
            const update = {updated_at: now};
            if (patch.key !== undefined) update.key = String(patch.key ?? '');
            if (patch.value !== undefined) update.value = valueForDb(patch.value);
            if (patch.description !== undefined) update.description = String(patch.description ?? '');
            if (patch.status !== undefined) update.status = patch.status ? 1 : 0;
            if (patch.botName !== undefined || patch.bot_name !== undefined) update.bot_name = String(patch.botName ?? patch.bot_name ?? 'none');
            await knex('bot_single_value_control').where('token', existing.token).update(update);
            const after = await findControl(type, existing.token);
            await history.record(type, existing.token, 'update', existing, after, 'mcp');
            return {type, ...after};
        }
        await mapperApi.schemaReady;
        const update = {updated_at: now};
        if (patch.key !== undefined) { const key = String(patch.key || '').trim(); if (!key) throw new Error('Mapper key cannot be empty.'); update.key = key; }
        if (patch.title !== undefined) update.title = String(patch.title ?? '');
        if (patch.description !== undefined) update.description = String(patch.description ?? '');
        if (patch.example !== undefined) update.example_json = JSON.stringify(mapperApi.normalizeExample(patch.example));
        if (patch.rules !== undefined) update.rules_json = JSON.stringify(mapperApi.normalizeRules(patch.rules));
        await knex('bot_condition_mapper').where('token', existing.token).update(update);
        const after = await findControl(type, existing.token);
        await history.record(type, existing.token, 'update', existing, after, 'mcp');
        return {type, ...after};
    }

    async function deleteControl({type, id}) {
        const existing = await findControl(type, id);
        if (!existing) throw new Error(`${type} control not found: ${id}`);
        const stableId = type === 'toggle' ? existing.botName : existing.token;
        await knex.transaction(async trx => {
            if (type === 'toggle') await trx('bot_control').where('bot_name', stableId).del();
            else if (type === 'value') {
                await trx(temporaryLinkTable).where('value_token', stableId).del();
                await trx('bot_single_value_control').where('token', stableId).del();
            } else await trx('bot_condition_mapper').where('token', stableId).del();
            await history.record(type, stableId, 'delete', existing, null, 'mcp', trx);
        });
        return {deleted: true, type, id: stableId, previous: existing};
    }

    function buildServer() {
        const server = new McpServer(
            {name: 'simple-toggle', version: '1.0.0'},
            {instructions: 'Manage Simple Toggle toggles, values, and condition mappers. Stored descriptions explain intended meaning and should be treated as the source of truth. Use list_controls/get_control when a requested control is ambiguous. You may create, change, flip, delete, inspect history, and revert controls when the user asks.'}
        );

        const controlType = z.enum(['toggle', 'value', 'mapper']);

        server.registerTool('list_controls', {
            title: 'List Simple Toggle controls',
            description: 'List toggles, values, and condition mappers, including current state/value and descriptions. Use this to discover what can be changed.',
            inputSchema: z.object({type: controlType.optional()})
        }, safe(async ({type}) => ({controls: await listControls(type || null)})));

        server.registerTool('get_control', {
            title: 'Get a control',
            description: 'Read one control in full. id can be a toggle key, value token/key, or mapper token/key.',
            inputSchema: z.object({type: controlType, id: z.string().min(1)})
        }, safe(async ({type, id}) => {
            const control = await findControl(type, id);
            if (!control) throw new Error(`${type} control not found: ${id}`);
            return {type, control};
        }));

        server.registerTool('explain_control', {
            title: 'Explain a control',
            description: 'Return a human-readable explanation based on the stored description, current state/value, and mapper rules.',
            inputSchema: z.object({type: controlType, id: z.string().min(1)})
        }, safe(async ({type, id}) => {
            const control = await findControl(type, id);
            if (!control) throw new Error(`${type} control not found: ${id}`);
            return {type, control, explanation: explanation(type, control)};
        }));

        server.registerTool('create_control', {
            title: 'Create a control',
            description: 'Create a toggle, value, or mapper. For value use value/bot_name. For mapper use example/rules. Descriptions should explain what the control means to future humans and AIs.',
            inputSchema: z.object({type: controlType, key: z.string().min(1), title: z.string().optional(), description: z.string().optional(), status: z.boolean().optional(), value: z.any().optional(), bot_name: z.string().optional(), example: z.record(z.string(), z.any()).optional(), rules: z.array(z.any()).optional()})
        }, safe(createControl));

        server.registerTool('update_control', {
            title: 'Update any control',
            description: 'Change any editable property of a control. Toggle patch supports status/enabled/title/description; value supports key/value/description/status/bot_name; mapper supports key/title/description/example/rules.',
            inputSchema: z.object({type: controlType, id: z.string().min(1), patch: z.record(z.string(), z.any())})
        }, safe(updateControl));

        server.registerTool('flip_toggle', {
            title: 'Flip or set a toggle',
            description: 'Turn a toggle on, off, or invert its current state.',
            inputSchema: z.object({id: z.string().min(1), mode: z.enum(['on', 'off', 'flip']).default('flip')})
        }, safe(async ({id, mode}) => {
            const current = await findControl('toggle', id);
            if (!current) throw new Error(`Toggle not found: ${id}`);
            const status = mode === 'flip' ? !current.status : mode === 'on';
            return updateControl({type: 'toggle', id: current.botName, patch: {status}});
        }));

        server.registerTool('set_value', {
            title: 'Set a value control',
            description: 'Set the current value of a value control by permanent token or key.',
            inputSchema: z.object({id: z.string().min(1), value: z.any()})
        }, safe(async ({id, value}) => updateControl({type: 'value', id, patch: {value, status: true}})));

        server.registerTool('delete_control', {
            title: 'Delete a control',
            description: 'Delete a toggle, value, or mapper. The deletion is recorded in history and can be reverted later.',
            inputSchema: z.object({type: controlType, id: z.string().min(1)})
        }, safe(deleteControl));

        server.registerTool('evaluate_mapper', {
            title: 'Evaluate a condition mapper',
            description: 'Run an input JSON object through a mapper using first-match priority. Set merge=true to merge the result over the input.',
            inputSchema: z.object({id: z.string().min(1), input: z.record(z.string(), z.any()), merge: z.boolean().optional()})
        }, safe(async ({id, input, merge}) => {
            const mapper = await findControl('mapper', id);
            if (!mapper) throw new Error(`Mapper not found: ${id}`);
            const match = mapperApi.evaluateRules(mapperApi.normalizeRules(mapper.rules || []), input);
            return {matched: match.matched, ruleIndex: match.ruleIndex, ruleName: match.rule?.name || '', result: merge ? {...input, ...match.result} : match.result};
        }));

        server.registerTool('list_history', {
            title: 'List control history',
            description: 'List recent changes with timestamps, source, before state, and after state. History rolls at about 100 entries per control.',
            inputSchema: z.object({type: controlType.optional(), id: z.string().optional(), limit: z.number().int().min(1).max(500).optional()})
        }, safe(async args => ({history: await history.list(args)})));

        server.registerTool('revert_change', {
            title: 'Revert a historical change',
            description: 'Restore the control to the BEFORE snapshot of a history entry. This can also restore a deleted widget or undo a creation.',
            inputSchema: z.object({history_id: z.number().int().positive()})
        }, safe(async ({history_id}) => {
            const reverted = await history.revert(history_id, 'mcp');
            if (!reverted) throw new Error(`History entry not found: ${history_id}`);
            return reverted;
        }));

        server.registerResource('controls', 'simple-toggle://controls', {title: 'Simple Toggle controls', description: 'All current controls and their descriptions.', mimeType: 'application/json'}, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await listControls(), null, 2)}]}));
        server.registerResource('history', 'simple-toggle://history', {title: 'Simple Toggle recent history', description: 'Recent control changes, including before/after snapshots.', mimeType: 'application/json'}, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await history.list({limit: 100}), null, 2)}]}));
        return server;
    }

    const originAllowed = req => {
        const origin = req.get('origin');
        if (!origin) return true;
        try {
            const originUrl = new URL(origin);
            if (originUrl.host === req.get('host')) return true;
            if (configuredUrl && originUrl.origin === new URL(configuredUrl).origin) return true;
            return false;
        } catch { return false; }
    };

    app.all('/mcp', async (req, res) => {
        if (!originAllowed(req)) return res.status(403).json({error: 'Origin not allowed.'});
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
        res.on('close', () => { Promise.resolve(transport.close()).catch(() => {}); Promise.resolve(server.close()).catch(() => {}); });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error('MCP request failed:', err);
            if (!res.headersSent) res.status(500).json({jsonrpc: '2.0', error: {code: -32603, message: 'Internal MCP server error'}, id: null});
        }
    });

    return {buildServer, listControls, findControl};
};
