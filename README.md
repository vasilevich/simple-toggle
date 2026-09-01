# Simple Toggle

A tiny control server for remote toggles, editable values, and condition mappers, with a web UI, Node.js client, change history, and MCP support.

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

Each value control has two different credentials:

- **Permanent value token** — long-lived access to that value. It remains valid until the value card is deleted.
- **One-time set code** — short `/t/...` URL that can set the value once and is then destroyed.

The permanent value API is:

```text
GET  /v/<permanent-value-token>
POST /v/<permanent-value-token>
```

It does not require the global admin token because the permanent value token itself is the credential.

```js
const values = await BotControl.getValues();
const valuesByKey = await BotControl.getValuesMap();

console.log(valuesByKey.feature_message);

const value = await BotControl.getValueByKey('feature_message', 'default');
await BotControl.setValueByKey('feature_message', 'hello');
```

If you already have a permanent value token:

```js
const value = await BotControl.getValueOnlyValue(valueToken, 'default');
await BotControl.setValue(valueToken, 'new value');

console.log(BotControl.getPermanentValueUrl(valueToken, true));
```

Deleting the value itself is still an admin operation:

```js
await BotControl.deleteValue(valueToken);
```

### Short one-time setter links

Create a short public URL for an existing value control. The URL contains no admin token, can be submitted once, and is invalidated immediately after a successful set. The value itself remains stored and the permanent token remains valid.

It expires after 7 days by default.

```js
const link = await BotControl.createTemporarySetUrl(valueToken);
console.log(link.url); // https://toggle.example.com/t/aB93xK7q
```

Or locate the value by key:

```js
const link = await BotControl.createTemporarySetUrlByKey('customer_reply');
```

Pass `0` to disable the time expiry while keeping the link single-use:

```js
const link = await BotControl.createTemporarySetUrl(valueToken, 0);
```

You can also create a brand-new value control and its temporary link in one call:

```js
const crm = new BotControl('crm');
const link = await crm.generateTemporaryUrl('customer_reply', 'Reply from customer');

console.log(link.permanent_access_token);
console.log(link.temporary_url);
```

### Toggles

```js
const worker = new BotControl('worker-name');

await worker.enable();
await worker.disable();
const status = await worker.getStatus();
```

### Condition mappers

A mapper accepts an input JSON object and returns the result from the first matching rule. Rules are ordered by priority and can contain nested AND/OR groups.

```js
const mapper = await BotControl.createMapper({
  key: 'order-coupon',
  description: 'Selects the coupon used when importing an order.',
  example: {destination: 'jpn', total: 120},
  rules: [{
    name: 'Japan',
    when: {type: 'condition', field: 'destination', operator: 'eq', value: 'jpn'},
    result: {coupon: 'japan'}
  }]
});

const result = await BotControl.map(mapper.token, {destination: 'jpn', total: 50});
```

The web UI builds field helpers automatically from the mapper's example object.

## MCP

The server exposes an **unauthenticated** Streamable HTTP MCP endpoint:

```text
https://toggle.example.com/mcp
```

There is intentionally no bearer token, API key, or OAuth requirement on this endpoint. Anyone who can reach `/mcp` can inspect, create, modify, flip, delete, and restore controls. Put the server behind a network boundary if that is not acceptable for your deployment.

The MCP server exposes these tools:

- `list_controls` / `search_controls` / `get_control`
- `explain_control` — explains meaning from the stored description and current state/value
- `create_control` / `update_control` / `delete_control`
- `flip_toggle` / `set_value`
- `evaluate_mapper`
- `list_history` / `revert_change`

It also exposes `simple-toggle://controls` and `simple-toggle://history` resources.

The web UI's **History** tab shows the exact MCP URL with a copy button.

## Change history

Changes made through the normal API/web UI, permanent value URLs, one-time value links, and MCP are recorded as before/after snapshots with a timestamp and source.

History is rolling per control and defaults to the newest 100 entries. Change `historyLimit` in `config/default.json` to keep more or fewer.

The **History** tab shows compact `from → to` changes plus full JSON snapshots. **Revert** restores the state from immediately before that history entry. This also means a deleted widget can be restored, and reverting a creation removes the widget again.

## Server

```bash
npm start
```

Server configuration lives in `config/default.json` and can be overridden through the `config` package as before.
