const config = require('config');
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const token = config.get('token');  // Replace with your actual static token
const db = new sqlite3.Database(config.get('db').path, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        return console.error(err.message);
    }
    console.log('Connected to the SQlite database.');
});
db.run('CREATE TABLE IF NOT EXISTS bot_control(bot_name text PRIMARY KEY, title text, description text, status INTEGER)', (err) => {
    if (err) {
        return console.log(err.message);
    }
    console.log('Table created.');
});

const app = express();

app.use(express.static('public'));

app.use((req, res, next) => {
    let authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).send('Authorization header missing');
        return;
    }

    let authParts = authHeader.split(' ');
    if (authParts.length != 2 || authParts[0].toLowerCase() != 'bearer') {
        res.status(401).send('Invalid authorization format');
        return;
    }

    let providedToken = authParts[1];
    if (providedToken != token) {
        res.status(401).send('Invalid token');
        return;
    }

    next();
});


app.use(bodyParser.json());
app.use(cors());

app.get('/bots', (req, res) => {
    let sql = 'SELECT * FROM bot_control';
    db.all(sql, [], (err, rows) => {
        if (err) {
            return console.error(err.message);
        }
        res.json(rows.map(row => ({
            botName: row.bot_name,
            title: row.title,
            description: row.description,
            status: row.status === 1
        })));
    });
});


app.post('/bot/:bot_name', (req, res) => {
    let data = [req.params.bot_name, req.body.title, req.body.description, req.body.status ? 1 : 0];
    let checkSql = 'SELECT * FROM bot_control WHERE bot_name = ?';
    db.get(checkSql, [req.params.bot_name], (err, row) => {
        if (err) {
            console.log(err);
            return res.status(500).send(err);
        }

        if (row) {
            console.log(`Found bot: ${JSON.stringify(row)}`);
            let updateSql = 'UPDATE bot_control SET status = ? WHERE bot_name = ?';
            db.run(updateSql, [req.body.status ? 1 : 0, req.params.bot_name], (err) => {
                if (err) {
                    console.log(err);
                    return res.status(500).send(err);
                }

                res.json({status: req.body.status ? true : false});
            });
        } else {
            console.log(`Inserting new bot: ${JSON.stringify(data)}`);
            let insertSql = 'INSERT INTO bot_control(bot_name, title, description, status) VALUES(?, ?, ?, ?)';
            db.run(insertSql, data, (err) => {
                if (err) {
                    console.log(err);
                    return res.status(500).send(err);
                }

                res.json({status: req.body.status ? true : false});
            });
        }
    });
});


app.delete('/bot/:bot_name', (req, res) => {
    let sql = 'DELETE FROM bot_control WHERE bot_name = ?';
    db.run(sql, [req.params.bot_name], (err) => {
        if (err) {
            console.log(err);
            return res.status(500).send(err);
        }

        res.json({status: 'success'});
    });
});

app.listen(config.get('port'), config.get('hostname'), () => {
    console.log(`Server running on port ${config.get('port')}`);
});


require("greenlock-express")
    .init({
        packageRoot: './',
        configDir: "./greenlock.d",

        // contact for security and critical bug notices
        maintainerEmail: "jon@example.com",

        // whether or not to run at cloudscale
        cluster: false
    })