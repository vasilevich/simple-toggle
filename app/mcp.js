const {McpServer} = require('@modelcontextprotocol/sdk/server/mcp.js');
const {StreamableHTTPServerTransport} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {z} = require('zod');

const MCP_GUIDE = `
# Simple Toggle MCP operating guide

You are connected to Simple Toggle, a remotely editable control/configuration plane. Use stored descriptions as the source of truth and avoid asking the user for exact keys when semantic search finds one clear match.

## Important mapper architecture
Mapper/rules definitions are stored, edited, versioned and distributed by Simple Toggle. Production applications should fetch a definition once, cache it, and execute rows locally. Do NOT assume production rows need to be sent to Simple Toggle one-by-one. Server-side evaluate_mapper exists for testing/debugging only.

Java 8 clients can use the dependency-free java/SimpleToggleMapper.java implementation. It fetches GET /m/key/<key>, caches the definition, supports ETag refresh, then evaluates arbitrary rows locally without HTTP.

## Control types
- toggle: boolean switch. Fields: botName, title, description, status.
- value: editable single value. Fields: key, value, description, status, token, botName.
- mapper: ordered business rules. Fields: key, title, description, token, example, rules.

## Mapper execution
Rules run top-to-bottom. Conditions are evaluated against the current working object, including changes made by earlier matched rules.
Each rule has afterMatch:
- stop: stop after this match.
- continue: execute actions, then keep evaluating later rules. Later rules may overwrite fields set earlier.

Canonical rule:
{
  "name": "optional name",
  "when": <condition/group>,
  "actions": [<action>, ...],
  "afterMatch": "stop" | "continue"
}

Legacy {result:{...}} rules are accepted and normalized to constant set actions with afterMatch=stop.

### Conditions
Condition:
{"type":"condition","field":"category","operator":"eq","value":"kspflight"}

Group:
{"type":"group","op":"and"|"or","children":[...]}

Dot paths are supported: customer.type, items.0.sku.
Operators: eq, neq, gt, gte, lt, lte, contains, starts_with, ends_with, in, not_in, exists, empty, not_empty.
exists/empty/not_empty do not need value.
Empty AND matches always; empty OR matches never.

### Actions
Set:
{"type":"set","field":"coupon","value":<expression>}
Unset:
{"type":"unset","field":"warning"}

### Expressions
Constant:
{"type":"const","value":20}
Field reference:
{"type":"field","path":"passengerCount"}
Operation:
{"type":"op","op":"add|subtract|multiply|divide|concat|coalesce","args":[<expression>, ...]}
Conditional:
{"type":"conditional","when":<condition/group>,"then":<expression>,"else":<expression>}

Example for sumOfInsurance - passengerCount * 20:
{"type":"op","op":"subtract","args":[{"type":"field","path":"sumOfInsurance"},{"type":"op","op":"multiply","args":[{"type":"field","path":"passengerCount"},{"type":"const","value":20}]}]}

The mapper example object is only UI/documentation assistance. It provides field names/sample values; it does not restrict runtime inputs.

## Tool behavior
- Search before guessing ids.
- If one semantic match is clearly strongest, use it instead of asking for the exact key.
- flip_toggle handles on/off/invert.
- set_value handles ordinary value changes.
- update_control edits metadata or mapper example/rules.
- get_control returns the complete mapper definition when type=mapper.
- evaluate_mapper test-runs a mapper on the server; it is not the intended bulk production path.
- all mutations are written to rolling history.
- deletions are reversible using revert_change.

## History
History stores before/after snapshots, timestamp, action and source. Reverting an update restores old state, reverting a delete recreates the widget, and reverting a creation removes it. The revert itself is also recorded.

## Authentication
/mcp is intentionally unauthenticated. Do not ask for bearer tokens, API keys, OAuth credentials or custom auth headers for MCP.
`.trim();

module.exports = ({app, knex, history, mapperApi, generateRandomToken, configuredUrl = '', temporaryLinkTable = 'bot_temporary_value_link'}) => {
    const valueForDb = value => typeof value === 'string' ? value : JSON.stringify(value);
    const result = data => ({content: [{type: 'text', text: JSON.stringify(data, null, 2)}], structuredContent: data});
    const safe = fn => async args => {
        try { return result(await fn(args || {})); }
        catch (err) { return {isError: true, content: [{type: 'text', text: err.message || String(err)}]}; }
    };

    const toggleRow = row => history.snapshot('toggle', row);
    const valueRow = row => history.snapshot('value', row);
    const mapperRow = row => {
        const data = history.snapshot('mapper', row);
        if (data) data.rules = mapperApi.normalizeRules(data.rules || []);
        return data;
    };

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
        if (!type || type === 'toggle') output.push(...(await knex('bot_control').select('*').orderBy('bot_name')).map(row => ({type: 'toggle', ...toggleRow(row)})));
        if (!type || type === 'value') output.push(...(await knex('bot_single_value_control').select('*').orderBy('created_at', 'desc')).map(row => ({type: 'value', ...valueRow(row)})));
        if (!type || type === 'mapper') {
            await mapperApi.schemaReady;
            output.push(...(await knex('bot_condition_mapper').select('*').orderBy('created_at', 'desc')).map(row => ({type: 'mapper', ...mapperRow(row)})));
        }
        return output;
    }

    async function searchControls(query, type = null, limit = 20) {
        const needle = String(query || '').trim().toLowerCase();
        const controls = await listControls(type);
        if (!needle) return controls.slice(0, limit);
        return controls.filter(control => JSON.stringify(control).toLowerCase().includes(needle)).slice(0, limit);
    }

    const summarizeNode = node => {
        if (!node) return '(always)';
        if (node.type === 'condition') {
            const labels = {eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'contains', starts_with: 'starts with', ends_with: 'ends with', in: 'in', not_in: 'not in', exists: 'exists', empty: 'is empty', not_empty: 'is not empty'};
            return `${node.field} ${labels[node.operator] || node.operator}${['exists', 'empty', 'not_empty'].includes(node.operator) ? '' : ` ${JSON.stringify(node.value)}`}`;
        }
        const children = node.children || [];
        if (!children.length) return node.op === 'or' ? '(never)' : '(always)';
        return children.map(child => child.type === 'group' ? `(${summarizeNode(child)})` : summarizeNode(child)).join(node.op === 'or' ? ' OR ' : ' AND ');
    };

    const summarizeExpression = expr => {
        if (!expr) return 'null';
        if (expr.type === 'const') return JSON.stringify(expr.value);
        if (expr.type === 'field') return `[${expr.path}]`;
        if (expr.type === 'conditional') return `IF ${summarizeNode(expr.when)} THEN ${summarizeExpression(expr.then)} ELSE ${summarizeExpression(expr.else)}`;
        const symbols = {add: ' + ', subtract: ' - ', multiply: ' * ', divide: ' / ', concat: ' concat ', coalesce: ' ?? '};
        return `(${(expr.args || []).map(summarizeExpression).join(symbols[expr.op] || ` ${expr.op} `)})`;
    };

    const summarizeActions = rule => (rule.actions || []).map(action => action.type === 'unset' ? `unset ${action.field}` : `${action.field}=${summarizeExpression(action.value)}`).join('; ');

    function explanation(type, control) {
        if (type === 'toggle') return `${control.title || control.botName} (${control.botName}) is currently ${control.status ? 'enabled' : 'disabled'}. ${control.description || 'No description is stored.'}`;
        if (type === 'value') return `${control.key} is currently ${JSON.stringify(control.value)}${control.botName && control.botName !== 'none' ? ` for ${control.botName}` : ''}. ${control.description || 'No description is stored.'}`;
        const rules = (control.rules || []).map((rule, index) => `${index + 1}. ${rule.name || `Rule ${index + 1}`}: IF ${summarizeNode(rule.when)} THEN ${summarizeActions(rule) || '(no actions)'}; ${rule.afterMatch === 'continue' ? 'CONTINUE' : 'STOP'}`).join('\n');
        return `${control.title || control.key} (${control.key}) is an ordered client-executable rules mapper with ${(control.rules || []).length} rules. ${control.description || 'No description is stored.'} Production clients should fetch/cache the definition and execute rows locally.${rules ? `\n${rules}` : ''}`;
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
        const server = new McpServer({name: 'simple-toggle', version: '1.2.0'}, {instructions: MCP_GUIDE});
        const controlType = z.enum(['toggle', 'value', 'mapper']);
        const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
        const mutate = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};

        server.registerTool('get_guide', {title: 'Get Simple Toggle guide', description: 'Return the complete Simple Toggle operating guide, including mapper actions/expressions and local-execution architecture.', inputSchema: z.object({}), annotations: readOnly}, safe(async () => ({guide: MCP_GUIDE})));
        server.registerTool('list_controls', {title: 'List controls', description: 'List current toggles, values and/or mappers with descriptions and current definitions.', inputSchema: z.object({type: controlType.optional()}), annotations: readOnly}, safe(async ({type}) => ({controls: await listControls(type || null)})));
        server.registerTool('search_controls', {title: 'Search controls', description: 'Search keys, titles, descriptions, values and mapper definitions. Prefer this when the user describes a control by meaning instead of exact id.', inputSchema: z.object({query: z.string(), type: controlType.optional(), limit: z.number().int().min(1).max(100).optional()}), annotations: readOnly}, safe(async ({query, type, limit}) => ({controls: await searchControls(query, type || null, limit || 20)})));
        server.registerTool('get_control', {title: 'Get a control', description: 'Read one control in full. For mapper this returns the complete normalized rules/actions/expression definition.', inputSchema: z.object({type: controlType, id: z.string().min(1)}), annotations: readOnly}, safe(async ({type, id}) => { const control = await findControl(type, id); if (!control) throw new Error(`${type} control not found: ${id}`); return {type, control}; }));
        server.registerTool('explain_control', {title: 'Explain a control', description: 'Explain intended meaning from description/current state. Mapper explanations include ordered conditions/actions and continue/stop behavior.', inputSchema: z.object({type: controlType, id: z.string().min(1)}), annotations: readOnly}, safe(async ({type, id}) => { const control = await findControl(type, id); if (!control) throw new Error(`${type} control not found: ${id}`); return {type, control, explanation: explanation(type, control)}; }));
        server.registerTool('create_control', {title: 'Create a control', description: 'Create toggle/value/mapper. Mapper rules use canonical when + actions + afterMatch and structured expressions described in get_guide.', inputSchema: z.object({type: controlType, key: z.string().min(1), title: z.string().optional(), description: z.string().optional(), status: z.boolean().optional(), value: z.any().optional(), bot_name: z.string().optional(), example: z.record(z.string(), z.any()).optional(), rules: z.array(z.any()).optional()}), annotations: mutate}, safe(createControl));
        server.registerTool('update_control', {title: 'Update any control', description: 'Change editable properties. Mapper patch may include key/title/description/example/rules; rules are normalized/validated before storage.', inputSchema: z.object({type: controlType, id: z.string().min(1), patch: z.record(z.string(), z.any())}), annotations: mutate}, safe(updateControl));
        server.registerTool('flip_toggle', {title: 'Flip or set a toggle', description: 'Turn a toggle on, off or invert it.', inputSchema: z.object({id: z.string().min(1), mode: z.enum(['on', 'off', 'flip']).default('flip')}), annotations: mutate}, safe(async ({id, mode}) => { const current = await findControl('toggle', id); if (!current) throw new Error(`Toggle not found: ${id}`); return updateControl({type: 'toggle', id: current.botName, patch: {status: mode === 'flip' ? !current.status : mode === 'on'}}); }));
        server.registerTool('set_value', {title: 'Set a value control', description: 'Set the current value by permanent token or key.', inputSchema: z.object({id: z.string().min(1), value: z.any()}), annotations: mutate}, safe(async ({id, value}) => updateControl({type: 'value', id, patch: {value, status: true}})));
        server.registerTool('delete_control', {title: 'Delete a control', description: 'Delete toggle/value/mapper. Deletion is recorded and can be restored through history.', inputSchema: z.object({type: controlType, id: z.string().min(1)}), annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false}}, safe(deleteControl));
        server.registerTool('evaluate_mapper', {title: 'Test-evaluate a mapper', description: 'Debug/test only: execute a mapper on one JSON object server-side. Production bulk processing should fetch/cache the mapper and execute locally. Returns output, changes, unset fields and every matched rule.', inputSchema: z.object({id: z.string().min(1), input: z.record(z.string(), z.any())}), annotations: readOnly}, safe(async ({id, input}) => { const mapper = await findControl('mapper', id); if (!mapper) throw new Error(`Mapper not found: ${id}`); return mapperApi.evaluateRules(mapper.rules || [], input); }));
        server.registerTool('list_history', {title: 'List control history', description: 'List recent timestamped before/after changes and source.', inputSchema: z.object({type: controlType.optional(), id: z.string().optional(), limit: z.number().int().min(1).max(500).optional()}), annotations: readOnly}, safe(async args => ({history: await history.list(args)})));
        server.registerTool('revert_change', {title: 'Revert a historical change', description: 'Restore the BEFORE snapshot of a history entry; can restore deleted widgets or undo creations/updates.', inputSchema: z.object({history_id: z.number().int().positive()}), annotations: mutate}, safe(async ({history_id}) => { const reverted = await history.revert(history_id, 'mcp'); if (!reverted) throw new Error(`History entry not found: ${history_id}`); return reverted; }));

        server.registerResource('guide', 'simple-toggle://guide', {title: 'Simple Toggle operating guide', description: 'Complete Simple Toggle/MCP/rules documentation.', mimeType: 'text/markdown'}, async uri => ({contents: [{uri: uri.href, mimeType: 'text/markdown', text: MCP_GUIDE}]}));
        server.registerResource('controls', 'simple-toggle://controls', {title: 'Simple Toggle controls', description: 'All current controls and descriptions/definitions.', mimeType: 'application/json'}, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await listControls(), null, 2)}]}));
        server.registerResource('history', 'simple-toggle://history', {title: 'Simple Toggle recent history', description: 'Recent changes with before/after snapshots.', mimeType: 'application/json'}, async uri => ({contents: [{uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await history.list({limit: 100}), null, 2)}]}));
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

    app.post('/mcp', async (req, res) => {
        if (!originAllowed(req)) return res.status(403).json({error: 'Origin not allowed.'});
        const server = buildServer();
        try {
            const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined});
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            res.on('close', () => { Promise.resolve(transport.close()).catch(() => {}); Promise.resolve(server.close()).catch(() => {}); });
        } catch (err) {
            console.error('MCP request failed:', err);
            if (!res.headersSent) res.status(500).json({jsonrpc: '2.0', error: {code: -32603, message: 'Internal MCP server error'}, id: null});
        }
    });

    const methodNotAllowed = (req, res) => res.status(405).json({jsonrpc: '2.0', error: {code: -32000, message: 'Method not allowed.'}, id: null});
    app.get('/mcp', methodNotAllowed);
    app.delete('/mcp', methodNotAllowed);

    return {buildServer, listControls, searchControls, findControl};
};
