const config = require('config');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {createProxyMiddleware} = require("http-proxy-middleware");
const rtg = require('random-token-generator');
const token = config.get('token');  // Replace with your actual static token
const knex = require('knex')({
    client: 'sqlite3',
    connection: {
        filename: config.get('db').path
    },
    useNullAsDefault: true // as SQLite3 is the only client that allows NULL by default
});

const generateRandomToken = () => {
    return new Promise(resolve => {
        rtg.generateKey({
            len: 36, // Generate 16 characters or bytes of data
            string: true, // Output keys as a hex string
            strong: true, // Use the crypographically secure randomBytes function
            retry: true // Retry once on error
        }, function (err, key) {
            resolve(key);
        });
    });
};
knex.schema
    .hasTable('bot_control')
    .then(function (exists) {
        if (!exists) {
            return knex.schema.createTable('bot_control', function (table) {
                table.text('bot_name').primary();
                table.text('title');
                table.text('description');
                table.integer('status');
                table.date('updated_at');
                table.date('created_at');
            });
        }
    })
    .then(() => {
        return knex.schema.hasTable('bot_single_value_control');
    })
    .then(function (exists) {
        if (!exists) {
            return knex.schema.createTable('bot_single_value_control', function (table) {
                table.text('key');
                table.text('value');
                table.text('description');
                table.integer('status');
                table.text('token');
                table.text('bot_name');
                table.date('updated_at');
                table.date('created_at');
            });
        }
    })
    .catch((err) => console.log(err.message));

const app = express();

app.use(express.static('public'));
app.use(bodyParser.json());
app.use(cors());

const verify_request = (req, res) => {
    const query_param_token = req.query.token;

    if (query_param_token && query_param_token === token) {
        return true;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send('Authorization header missing');
        return false;
    }

    const authParts = authHeader.split(' ');
    if (authParts.length != 2 || authParts[0].toLowerCase() != 'bearer') {
        res.status(401).send('Invalid authorization format');
        return false;
    }

    let providedToken = authParts[1];
    if (providedToken != token) {
        res.status(401).send('Invalid token');
        return false;
    }
    return true;
};


app.get('/bot/generate_link', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            // generate random token for the URL
            const randomToken = await generateRandomToken();
            const now = new Date();
            const data = {
                key: req.query.key,
                description: req.query.description || '',
                value: req.query.value || "",
                status: 0,
                token: randomToken,
                bot_name: req.query.bot_name || 'none',
                updated_at: now,
                created_at: now,
            };

            // insert a new row into the bot_single_value_control table
            await knex('bot_single_value_control').insert(data);

            res.json({
                key: req.query.key,
                token: randomToken,
                url: `${req.protocol}://${req.hostname}:${config.get('port')}`,
                set_value_path: `bot/set_value/${randomToken}&token=${token}`,
                get_value_path: `bot/get_value/${randomToken}&token=${token}`,
                user_path: `bot_value_set.html?valueToken=${randomToken}&token=${token}`
            });
        } catch (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    }
});


app.post('/bot/generate_link', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            // generate random token for the URL
            const randomToken = await generateRandomToken();
            const now = new Date();
            const data = {
                key: req.body.key,
                description: req.body.description || req.query.description || '',
                value: req.body.value || req.query.value || "",
                status: 0,
                token: randomToken,
                bot_name: req.body.bot_name || req.query.bot_name || 'none',
                updated_at: now,
                created_at: now,
            };

            // insert a new row into the bot_single_value_control table
            await knex('bot_single_value_control').insert(data);

            res.json({
                key: req.query.key,
                token: randomToken,
                url: `${req.protocol}://${req.hostname}:${config.get('port')}`,
                set_value_path: `bot/set_value/${randomToken}&token=${token}`,
                get_value_path: `bot/get_value/${randomToken}&token=${token}`,
                user_path: `bot_value_set.html?valueToken=${randomToken}&token=${token}`
            });
        } catch (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    }
});

app.post('/bot/set_value/:token', async (req, res) => {
    const token = req.params.token;
    const value = req.body.value;

    try {
        const now = new Date();
        const row = await knex('bot_single_value_control').where('token', token).first();

        if (row) {
            const result = await knex('bot_single_value_control').where('token', token).update({
                value: value,
                status: 1,
                updated_at: now
            });

            return res.json({status: "success"});
        } else {
            return res.status(404).send({error: 'Invalid token.'});
        }
    } catch (err) {
        console.log(err);
        return res.status(500).send(err);
    }
});


app.get('/bot/get_value/:token', async (req, res) => {
    if (verify_request(req, res)) {
        const token = req.params.token;
        const isOnlyValue = (req.query.onlyvalue || req.query.only_value) === 'true';
        try {
            const row = await knex('bot_single_value_control').where('token', token).first();

            if (row) {
                if (isOnlyValue) {
                    // set content type to text/plain
                    res.set('Content-Type', 'text/plain');
                    return res.send(row.value);
                } else {
                    return res.json(row);
                }
            } else {
                return res.status(404).send({error: 'Invalid token.'});
            }
        } catch (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    }
});


// get all the bot statuses
app.get('/bots', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            const rows = await knex.select('*').from('bot_control');
            res.json(rows.map(row => ({
                botName: row.bot_name,
                title: row.title,
                description: row.description,
                status: row.status === 1
            })));
        } catch (err) {
            console.error(err.message);
        }
    }
});

// get specific bot status
app.get('/bot/:botName', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            const botName = req.params.botName;
            const row = await knex('bot_control').where('bot_name', botName).first();
            if (row) {
                return res.json({botName: row.bot_name, status: Boolean(row.status)});
            } else {
                return res.status(404).send({error: 'Bot not found.'});
            }
        } catch (err) {
            return res.status(500).send({error: 'An error occurred while retrieving bot status.'});
        }
    }
});

// modify bot status
app.post('/bot/:bot_name', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            const botName = req.params.bot_name;
            const data = {
                bot_name: botName,
                title: req.body.title,
                description: req.body.description,
                status: req.body.status ? 1 : 0
            };

            const row = await knex('bot_control').where('bot_name', botName).first();

            if (row) {
                await knex('bot_control').where('bot_name', botName).update({status: data.status});
            } else {
                await knex('bot_control').insert(data);
            }

            res.json({status: req.body.status ? true : false});

        } catch (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    }
});

// delete bot
app.delete('/bot/:bot_name', async (req, res) => {
    if (verify_request(req, res)) {
        try {
            await knex('bot_control').where('bot_name', req.params.bot_name).del();
            res.json({status: 'success'});
        } catch (err) {
            console.log(err);
            return res.status(500).send(err);
        }
    }
});

const wsProxy = createProxyMiddleware({
    target: 'http://kuma',
    changeOrigin: true,
    ws: true,
    logger: console,
});
app.use(wsProxy);
app.on('upgrade', wsProxy.upgrade);

app.use('/dashboard', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));
app.use('/assets', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));
app.use('/manifest.json', createProxyMiddleware({target: 'http://kuma', ws: true, changeOrigin: true}));

app.listen(config.get('port'), config.get('hostname'), () => {
    console.log(`Server running on port ${config.get('port')}`);
});
