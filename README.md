# Simple Toggle

A tiny authenticated server for remote toggles and single-value controls, with a web UI and Node.js client.

## Client

Requires Node.js 18+.

```bash
npm install github:vasilevich/simple-toggle
```

### CommonJS

```js
const BotControl = require('bots-status-manager');

BotControl.configure({
  url: 'https://toggle.example.com',
  token: process.env.SIMPLE_TOGGLE_TOKEN
});
```

### ESM

```js
import BotControl from 'bots-status-manager';

BotControl.configure({
  url: 'https://toggle.example.com',
  token: process.env.SIMPLE_TOGGLE_TOKEN
});
```

You can also configure it positionally:

```js
BotControl.init('https://toggle.example.com', process.env.SIMPLE_TOGGLE_TOKEN);
```

### Values

```js
const values = await BotControl.getValues();
const valuesByKey = await BotControl.getValuesMap();

console.log(valuesByKey.feature_message);

const value = await BotControl.getValueByKey('feature_message', 'default');
await BotControl.setValueByKey('feature_message', 'hello');
```

If you already have a generated value token:

```js
const value = await BotControl.getValueOnlyValue(valueToken, 'default');
await BotControl.setValue(valueToken, 'new value');
await BotControl.deleteValue(valueToken);
```

### Toggles

```js
const worker = new BotControl('worker-name');

await worker.enable();
await worker.disable();
const status = await worker.getStatus();
```

### Generate a value control

```js
const worker = new BotControl('worker-name');
const link = await worker.generateUrl('message', 'Message shown by the worker', 'hello');

console.log(link.user_url);
console.log(link.get_value_url);
console.log(link.set_value_url);
```

## Server

```bash
npm start
```

Server configuration lives in `config/default.json` and can be overridden through the `config` package as before.
