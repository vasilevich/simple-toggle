const config = require('config');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {createProxyMiddleware} = require('http-proxy-middleware');
const rtg = require('random-token-generator');
const {randomBytes} = require('crypto');
const {existsSync, unlinkSync, chmodSync} = require('fs');
const token = config.get('token');
const configuredUrl = config.has('url') ? config.get('url') : '';
const getBaseUrl = req => (configuredUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const TEMP_LINK_TABLE = 'bot_temporary_value_link';
const DEFAULT_TEMP_LINK_MINUTES = 7 * 24 * 60;

if (config.get('knex') && config.get('knex').client === 'sqlite3') {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(config.get('knex').connection.filename);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    if (!fs.existsSync(config.get('knex').connection.filename)) fs.writeFileSync(config.get('knex').connection.filename, '');
}

const knexConfig = config.util.toObject().knex;
if (knexConfig.client === 'mariadb') knexConfig.client = require('knex-mariadb');
const knex = require('knex')(knexConfig);

const generateRandomToken = () => new Promise(resolve => {
    rtg.generateKey({len: 36, string: true, strong: true, retry: true}, (err, key) => resolve(key));
});
const generateShortCode = () => randomBytes(6).toString('base64url');

knex.schema.hasTable('bot_control')
    .then(exists => {
        if (!exists) {
            return knex.schema.createTable('bot_control', table => {
                table.string('bot_name', 255).primary();
                table.text('title');
                table.text('description');
                table.integer('status');
                table.date('updated_at');
                table.date('created_at');
            });
        }
    })
    .then(() => knex.schema.hasTable('bot_single_value_control'))
    .then(exists => {
        if (!exists) {
            return knex.schema.createTable('bot_single_value_control', table => {
                table.text('key');
                table.text('value');
                table.text('description');
                table.integer('status');
                table.text('token').unique();
                table.text('bot_name');
                table.date('updated_at');
                table.date('created_at');
            });
        }
    })
    .then(() => knex.schema.hasTable(TEMP_LINK_TABLE))
    .then(exists => {
        if (!exists) {
            return knex.schema.createTable(TEMP_LINK_TABLE, table => {
                table.string('code', 16).primary();
                table.text('value_token').notNullable().index();
                table.dateTime('expires_at').nullable();
                table.dateTime('created_at').notNullable();
            });
        }
    })
    .catch(err => console.log(err.message));

const app = express();
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));
app.use(cors());

const verify_request = (req, res) => {
    const query_param_token = req.query.token;
    if (query_param_token && query_param_token === token) return true;

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send('Authorization header missing');
        return false;
    }

    const authParts = authHeader.split(' ');
    if (authParts.length !== 2 || authParts[0].toLowerCase() !== 'bearer') {
        res.status(401).send('Invalid authorization format');
        return false;
    }

    if (authParts[1] !== token) {
        res.status(401).send('Invalid token');
        return false;
    }
    return true;
};

const buildValueControl = (req, randomToken) => {
    const now = new Date();
    return {
        key: req.body?.key ?? req.query.key,
        description: req.body?.description ?? req.query.description ?? '',
        value: req.body?.value ?? req.query.value ?? '',
        status: 0,
        token: randomToken,
        bot_name: req.body?.bot_name ?? req.query.bot_name ?? 'none',
        updated_at: now,
        created_at: now
    };
};

const valueControlResponse = (req, data) => ({
    key: data.key,
    token: data.token,
    url: getBaseUrl(req),
    set_value_path: `bot/set_value/${data.token}?token=${encodeURIComponent(token)}`,
    get_value_path: `bot/get_value/${data.token}?token=${encodeURIComponent(token)}`,
    user_path: `bot_value_set.html?valueToken=${encodeURIComponent(data.token)}&token=${encodeURIComponent(token)}`
});

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const temporaryPage = ({title, message, code, key, description, status = 200}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#0f172a;color:#e5e7eb}.card{width:min(520px,100%);background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;box-shadow:0 24px 70px #0007}.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;margin-bottom:8px}h1{margin:0 0 8px;font-size:28px}p{color:#cbd5e1;line-height:1.5}.description{white-space:pre-wrap}.notice{padding:12px 14px;border:1px solid #475569;border-radius:10px;background:#1e293b;margin:18px 0}label{display:block;font-weight:600;margin:18px 0 8px}input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #475569;background:#0f172a;color:#fff;font:inherit}button{width:100%;margin-top:14px;padding:13px 16px;border:0;border-radius:10px;background:#2563eb;color:white;font:inherit;font-weight:700;cursor:pointer}small{display:block;color:#94a3b8;margin-top:14px;text-align:center}@media(prefers-color-scheme:light){body{background:#f1f5f9;color:#0f172a}.card{background:#fff;border-color:#cbd5e1;box-shadow:0 24px 70px #64748b25}p{color:#475569}.notice{background:#f8fafc;border-color:#cbd5e1}input{background:#fff;color:#0f172a;border-color:#cbd5e1}small{color:#64748b}}
</style>
</head>
<body><main class="card"><div class="tag">One-time value link</div><h1>${escapeHtml(title)}</h1>${message ? `<div class="notice">${escapeHtml(message)}</div>` : ''}${key ? `<p><strong>${escapeHtml(key)}</strong></p>` : ''}${description ? `<p class="description">${escapeHtml(description)}</p>` : ''}${status === 200 && code ? `<form method="post" action="/t/${escapeHtml(code)}"><label for="value">Value</label><input id="value" name="value" autocomplete="off" autofocus><button type="submit">Set value</button></form><small>This link can be used once. After a successful submit it becomes invalid.</small>` : ''}</main></body></html>`;

const getTemporaryLink = async code => {
    const link = await knex(TEMP_LINK_TABLE).where('code', code).first();
    if (!link) return null;
    if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
        await knex(TEMP_LINK_TABLE).where('code', code).del();
        return null;
    }
    return link;
};

app.get('/bot/generate_link', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const randomToken = await generateRandomToken();
        const data = buildValueControl(req, randomToken);
        await knex('bot_single_value_control').insert(data);
        res.json(valueControlResponse(req, data));
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.post('/bot/generate_link', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const randomToken = await generateRandomToken();
        const data = buildValueControl(req, randomToken);
        await knex('bot_single_value_control').insert(data);
        res.json(valueControlResponse(req, data));
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.post('/bot/temp_link/:token', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const valueControl = await knex('bot_single_value_control').where('token', req.params.token).first();
        if (!valueControl) return res.status(404).json({error: 'Value control not found.'});

        const rawMinutes = req.body?.expires_in_minutes ?? DEFAULT_TEMP_LINK_MINUTES;
        const expiresInMinutes = Number(rawMinutes);
        if (!Number.isFinite(expiresInMinutes) || expiresInMinutes < 0) {
            return res.status(400).json({error: 'expires_in_minutes must be a number >= 0.'});
        }

        let code;
        for (let i = 0; i < 5; i++) {
            const candidate = generateShortCode();
            if (!await knex(TEMP_LINK_TABLE).where('code', candidate).first()) {
                code = candidate;
                break;
            }
        }
        if (!code) return res.status(500).json({error: 'Unable to generate a short link.'});

        const expiresAt = expiresInMinutes === 0 ? null : new Date(Date.now() + expiresInMinutes * 60 * 1000);
        await knex(TEMP_LINK_TABLE).insert({
            code,
            value_token: req.params.token,
            expires_at: expiresAt,
            created_at: new Date()
        });

        res.json({
            code,
            url: `${getBaseUrl(req)}/t/${code}`,
            expires_at: expiresAt,
            one_time: true
        });
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.get('/t/:code', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const link = await getTemporaryLink(req.params.code);
        if (!link) return res.status(410).send(temporaryPage({title: 'Link expired', message: 'This one-time link is invalid, expired, or has already been used.', status: 410}));

        const valueControl = await knex('bot_single_value_control').where('token', link.value_token).first();
        if (!valueControl) {
            await knex(TEMP_LINK_TABLE).where('code', req.params.code).del();
            return res.status(410).send(temporaryPage({title: 'Link expired', message: 'The value control for this link no longer exists.', status: 410}));
        }

        res.send(temporaryPage({
            title: 'Set value',
            code: req.params.code,
            key: valueControl.key,
            description: valueControl.description,
            status: 200
        }));
    } catch (err) {
        console.log(err);
        res.status(500).send(temporaryPage({title: 'Error', message: 'Unable to load this link.', status: 500}));
    }
});

app.post('/t/:code', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const result = await knex.transaction(async trx => {
            const link = await trx(TEMP_LINK_TABLE).where('code', req.params.code).first();
            if (!link) return {ok: false, reason: 'used'};
            if (link.expires_at && new Date(link.expires_at).getTime() <= Date.now()) {
                await trx(TEMP_LINK_TABLE).where('code', req.params.code).del();
                return {ok: false, reason: 'expired'};
            }

            const claimed = await trx(TEMP_LINK_TABLE).where('code', req.params.code).del();
            if (claimed !== 1) return {ok: false, reason: 'used'};

            const updated = await trx('bot_single_value_control').where('token', link.value_token).update({
                value: req.body?.value ?? '',
                status: 1,
                updated_at: new Date()
            });
            if (!updated) return {ok: false, reason: 'missing'};
            return {ok: true};
        });

        const wantsJson = req.is('application/json');
        if (!result.ok) {
            if (wantsJson) return res.status(410).json({error: 'This one-time link is invalid, expired, or already used.'});
            return res.status(410).send(temporaryPage({title: 'Link expired', message: 'This one-time link is invalid, expired, or has already been used.', status: 410}));
        }

        if (wantsJson) return res.json({status: 'success', consumed: true});
        res.send(temporaryPage({title: 'Value saved', message: 'The value was saved. This one-time link is now permanently invalid.', status: 201}));
    } catch (err) {
        console.log(err);
        res.status(500).send(temporaryPage({title: 'Error', message: 'Unable to save the value.', status: 500}));
    }
});

app.post('/bot/set_value/:token', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const row = await knex('bot_single_value_control').where('token', req.params.token).first();
        if (!row) return res.status(404).send({error: 'Invalid token.'});
        await knex('bot_single_value_control').where('token', req.params.token).update({
            value: req.body.value,
            status: 1,
            updated_at: new Date()
        });
        res.json({status: 'success'});
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.delete('/bot/delete_value/:token', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const row = await knex('bot_single_value_control').where('token', req.params.token).first();
        if (!row) return res.status(404).send({error: 'Invalid token.'});
        await knex.transaction(async trx => {
            await trx(TEMP_LINK_TABLE).where('value_token', req.params.token).del();
            await trx('bot_single_value_control').where('token', req.params.token).del();
        });
        res.json({success: 'Value deleted successfully.'});
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.get('/bot/get_value/:token', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const row = await knex('bot_single_value_control').where('token', req.params.token).first();
        if (!row) return res.status(404).send({error: 'Invalid token.'});
        if ((req.query.onlyvalue || req.query.only_value) === 'true') {
            res.set('Content-Type', 'text/plain');
            return res.send(row.value);
        }
        res.json(row);
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.get('/bot/values', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const rows = await knex.select('*').from('bot_single_value_control').orderBy('created_at', 'desc');
        res.json(rows.map(row => ({
            key: row.key,
            value: row.value,
            description: row.description,
            status: row.status === 1,
            token: row.token,
            botName: row.bot_name,
            updatedAt: row.updated_at,
            createdAt: row.created_at
        })));
    } catch (err) {
        console.error(err.message);
        res.status(500).send({error: 'Unable to retrieve value controls.'});
    }
});

app.get('/bots', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const rows = await knex.select('*').from('bot_control').orderBy('bot_name');
        res.json(rows.map(row => ({
            botName: row.bot_name,
            title: row.title,
            description: row.description,
            status: row.status === 1
        })));
    } catch (err) {
        console.error(err.message);
        res.status(500).send({error: 'Unable to retrieve bot controls.'});
    }
});

app.get('/bot/:botName', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const row = await knex('bot_control').where('bot_name', req.params.botName).first();
        if (!row) return res.status(404).send({code: 404, error: 'Bot not found.'});
        res.json({botName: row.bot_name, status: Boolean(row.status)});
    } catch (err) {
        res.status(500).send({error: 'An error occurred while retrieving bot status.'});
    }
});

app.post('/bot/:bot_name', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        const botName = req.params.bot_name;
        const data = {
            bot_name: botName,
            title: req.body.title,
            description: req.body.description,
            status: req.body.status ? 1 : 0,
            updated_at: new Date()
        };
        const row = await knex('bot_control').where('bot_name', botName).first();
        if (row) {
            const update = {status: data.status, updated_at: data.updated_at};
            if (req.body.title !== undefined) update.title = req.body.title;
            if (req.body.description !== undefined) update.description = req.body.description;
            await knex('bot_control').where('bot_name', botName).update(update);
        } else {
            data.created_at = new Date();
            await knex('bot_control').insert(data);
        }
        res.json({status: Boolean(data.status)});
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

app.delete('/bot/:bot_name', async (req, res) => {
    if (!verify_request(req, res)) return;
    try {
        await knex('bot_control').where('bot_name', req.params.bot_name).del();
        res.json({status: 'success'});
    } catch (err) {
        console.log(err);
        res.status(500).send(err);
    }
});

const wsProxy = createProxyMiddleware({target: 'http://kuma', changeOrigin: true, ws: true, logger: console});
app.use(wsProxy);
app.on('upgrade', wsProxy.upgrade);
app.use('/dashboard', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));
app.use('/assets', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));
app.use('/manifest.json', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));

const port = config.get('port');
const hostname = config.get('hostname');
const unixPath = config.has('unixPath') ? config.get('unixPath') : null;

if (unixPath) {
    if (existsSync(unixPath)) unlinkSync(unixPath);
    app.listen(unixPath, () => {
        console.log(`Server running on unix socket at ${unixPath}`);
        chmodSync(unixPath, '777');
    });
}

if (port && hostname) {
    app.listen(port, hostname, () => console.log(`Server running on port ${port}`));
} else if (port) {
    app.listen(port, () => console.log(`Server running on port ${port}`));
}
