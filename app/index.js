const config = require('config');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {createProxyMiddleware} = require('http-proxy-middleware');
const rtg = require('random-token-generator');
const {existsSync, unlinkSync, chmodSync} = require('fs');
const token = config.get('token');
const configuredUrl = config.has('url') ? config.get('url') : '';
const getBaseUrl = req => (configuredUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

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
    .catch(err => console.log(err.message));

const app = express();
app.use(express.static('public'));
app.use(bodyParser.json());
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
        await knex('bot_single_value_control').where('token', req.params.token).del();
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
