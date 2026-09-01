# Simple Toggle

Simple Toggle is a small self-hosted control server for things you want to change at runtime without redeploying code.

It provides:

- boolean **Toggles**
- editable **Values**
- ordered JSON **Condition Mappers**
- a browser control panel
- rolling, reversible change history
- a Node.js client
- an **unauthenticated MCP server** that can inspect and manage everything

The main idea is simple: put runtime decisions here instead of hardcoding them into applications.

## Quick start

Requires Node.js 18+.

```bash
npm install
npm start
```

Default server:

```text
http://127.0.0.1:3000
```

Default browser control panel:

```text
http://127.0.0.1:3000/?token=1234567890
```

Default MCP endpoint:

```text
http://127.0.0.1:3000/mcp
```

This repository uses npm. There is intentionally no `yarn.lock`.

## Configuration

Configuration lives in `config/default.json` and uses the `config` package, so normal environment-specific config overrides still work.

Important settings:

```json
{
  "url": "http://localhost",
  "port": 3000,
  "hostname": "127.0.0.1",
  "unixPath": "",
  "token": "1234567890",
  "historyLimit": 100
}
```

`token` protects the normal admin/web APIs.

`historyLimit` is the number of history rows retained **per control**.

The MCP endpoint is intentionally different: `/mcp` does **not** require this token or any other authentication.

# Control types

## Toggles

A toggle is a named boolean switch.

Example:

```text
key: process-new-orders
title: Process new orders
description: Controls whether the importer is allowed to create new orders.
status: ON
```

Use a toggle when the only meaningful state is on/off.

Node client:

```js
const BotControl = require('bots-status-manager');

BotControl.configure({
  url: 'https://toggle.example.com',
  token: process.env.SIMPLE_TOGGLE_TOKEN
});

const worker = new BotControl('process-new-orders');

await worker.enable();
await worker.disable();

const status = await worker.getStatus();
```

## Values

A value is a named single editable value.

Examples:

```text
default_coupon = TEST
support_phone = +972...
minimum_order_value = 100
```

The backing column is text. Strings are stored directly. When MCP receives a non-string value, it JSON-serializes it before storing it.

Each value has a permanent random token in addition to its friendly key.

Node client:

```js
const values = await BotControl.getValues();
const valuesByKey = await BotControl.getValuesMap();

const current = await BotControl.getValueByKey('default_coupon', 'none');

await BotControl.setValueByKey('default_coupon', 'TEST');
```

Permanent value-token API:

```text
GET  /v/<value-token>
POST /v/<value-token>
```

A permanent value token is itself sufficient to read/write that value.

### One-time setter links

You can create a URL that can set a value exactly once.

```js
const link = await BotControl.createTemporarySetUrl(valueToken);

console.log(link.url);
```

Or find it by key:

```js
const link = await BotControl.createTemporarySetUrlByKey('customer_reply');
```

The default expiry is 7 days.

Use `0` to disable time expiry while keeping the link single-use:

```js
const link = await BotControl.createTemporarySetUrl(valueToken, 0);
```

## Condition Mappers

A mapper takes an input JSON object and returns a JSON result object.

Rules are evaluated from top to bottom.

**The first matching rule wins.**

No match returns:

```json
{}
```

Example input:

```json
{
  "destination": "jpn",
  "total": 120,
  "customer": {
    "type": "vip"
  }
}
```

Example rules:

```json
[
  {
    "name": "Large Japan order",
    "when": {
      "type": "group",
      "op": "and",
      "children": [
        {
          "type": "condition",
          "field": "destination",
          "operator": "eq",
          "value": "jpn"
        },
        {
          "type": "condition",
          "field": "total",
          "operator": "gte",
          "value": 100
        }
      ]
    },
    "result": {
      "coupon": "japan100"
    }
  },
  {
    "name": "Any Japan order",
    "when": {
      "type": "condition",
      "field": "destination",
      "operator": "eq",
      "value": "jpn"
    },
    "result": {
      "coupon": "japan"
    }
  }
]
```

Input:

```json
{
  "destination": "jpn",
  "total": 120
}
```

Result:

```json
{
  "coupon": "japan100"
}
```

Input:

```json
{
  "destination": "jpn",
  "total": 20
}
```

Result:

```json
{
  "coupon": "japan"
}
```

### Mapper condition grammar

A simple condition:

```json
{
  "type": "condition",
  "field": "destination",
  "operator": "eq",
  "value": "jpn"
}
```

Nested conditions:

```json
{
  "type": "group",
  "op": "and",
  "children": [
    {
      "type": "condition",
      "field": "destination",
      "operator": "eq",
      "value": "jpn"
    },
    {
      "type": "group",
      "op": "or",
      "children": [
        {
          "type": "condition",
          "field": "total",
          "operator": "gte",
          "value": 100
        },
        {
          "type": "condition",
          "field": "customer.type",
          "operator": "eq",
          "value": "vip"
        }
      ]
    }
  ]
}
```

Groups support:

```text
and
or
```

Groups can contain conditions or other groups.

An empty `and` group matches always.

An empty `or` group matches never.

Fields support dot paths:

```text
customer.type
shipping.destination.country
items.0.sku
```

### Mapper operators

| Operator | Meaning |
| --- | --- |
| `eq` | equals |
| `neq` | not equal |
| `gt` | greater than |
| `gte` | greater than or equal |
| `lt` | less than |
| `lte` | less than or equal |
| `contains` | substring for strings, member for arrays |
| `starts_with` | string starts with |
| `ends_with` | string ends with |
| `in` | actual value is in expected list |
| `not_in` | actual value is not in expected list |
| `exists` | field is not null/undefined |
| `empty` | null, undefined, `""`, `[]`, or `{}` |
| `not_empty` | inverse of `empty` |

`exists`, `empty`, and `not_empty` do not need a `value`.

Numeric comparisons are numeric when both sides can be interpreted as numbers; otherwise comparison is string-based.

`in` and `not_in` accept an array or comma-separated values.

### Example object

Each mapper stores an `example` object.

It does **not** restrict runtime input.

It exists to make editing easier. The browser UI flattens it into field helpers such as:

```text
destination (jpn)
total (120)
customer.type (vip)
```

So you can send the server a representative object once and then build rules without manually defining a schema.

### Mapper runtime API

Each mapper gets a permanent token.

```text
POST /m/<mapper-token>
```

Body:

```json
{
  "destination": "jpn",
  "total": 120
}
```

Normal response:

```json
{
  "coupon": "japan100"
}
```

Merge mapper result over the original object:

```text
POST /m/<mapper-token>?merge=true
```

Return matching metadata:

```text
POST /m/<mapper-token>?meta=true
```

Node client:

```js
const result = await BotControl.map(mapperToken, order);

const merged = await BotControl.applyMap(mapperToken, order);

const byKey = await BotControl.mapByKey('order-coupon', order);
```

Create/update:

```js
const mapper = await BotControl.createMapper({
  key: 'order-coupon',
  title: 'Order coupon',
  description: 'Chooses which coupon is assigned during order import.',
  example: {
    destination: 'jpn',
    total: 120
  },
  rules: []
});

await BotControl.updateMapper(mapper.token, {
  description: 'Chooses which coupon is assigned during order import.'
});
```

# MCP server

## Endpoint

The MCP endpoint is:

```text
https://YOUR-SERVER/mcp
```

Transport:

```text
Streamable HTTP
```

Authentication:

```text
none
```

Do not configure an Authorization header, API key, bearer token, or OAuth for MCP.

The normal browser/admin token is unrelated to MCP.

A browser `Origin` header is checked only for same-origin/DNS-rebinding protection. Normal MCP clients generally do not need to provide any special header.

## Important security behavior

Anyone who can reach `/mcp` can control this server.

That includes reading, creating, editing, toggling, deleting, and restoring controls.

If that is too open for a deployment, restrict network access to the server/reverse proxy. The MCP implementation itself intentionally does not ask for credentials.

## What the AI is taught automatically

The AI does **not** need this README to understand the server.

The MCP server itself sends a detailed operating guide in its server instructions.

It explicitly explains:

- what a toggle is
- what a value is
- what a mapper is
- which identifier each type accepts
- how duplicate value/mapper keys resolve
- how the AI should search by meaning instead of asking you for exact keys
- when it should proceed versus ask about a genuinely ambiguous match
- all mapper JSON shapes
- all mapper operators
- dot-path behavior
- first-match priority
- empty AND/OR behavior
- how value serialization works
- history semantics
- how delete/revert works
- which tool to choose for each type of request
- that MCP has no authentication

Every MCP parameter also has its own schema description.

There is additionally a read-only tool:

```text
get_guide
```

and a resource:

```text
simple-toggle://guide
```

Both expose the same complete guide.

This is deliberate: there are few parameters, so the server spends tokens documenting them well to reduce clarification questions.

## How the AI resolves your request

If you say:

```text
turn off order importing
```

the intended flow is:

```text
search_controls("order importing")
→ identify the best matching toggle from key/title/description
→ flip_toggle(..., "off")
```

It should not ask you for the exact internal key when one clear result exists.

If you say:

```text
set the default coupon to TEST2
```

the intended flow is:

```text
search_controls("default coupon", type="value")
→ set_value(...)
```

If two different controls are genuinely equally plausible and changing the wrong one would matter, the AI should ask which one.

### Descriptions are important

Descriptions are the AI-facing documentation for your controls.

Good:

```text
Chooses the coupon code assigned to orders imported from supplier Excel files.
```

Less useful:

```text
Coupon.
```

Good descriptions let future AI sessions find and modify the right widget without asking you what it does.

## MCP tools

### `get_guide`

Parameters: none.

Returns the complete Simple Toggle MCP operating guide.

Use when the client/model wants exact semantics instead of asking the user.

### `list_controls`

Parameters:

```text
type? = toggle | value | mapper
```

Returns current controls including descriptions and current state/value/configuration.

Omit `type` to list everything.

### `search_controls`

Parameters:

```text
query
type?
limit?
```

Searches:

- keys
- titles
- descriptions
- current values
- value bot grouping
- mapper example objects
- mapper rules

This should usually be the first tool when a user refers to something by meaning rather than exact key.

### `get_control`

Parameters:

```text
type
id
```

Identifier rules:

```text
toggle: exact key/botName
value: permanent token OR key
mapper: permanent token OR key
```

When a value or mapper key exists more than once, key lookup resolves the newest matching row.

### `explain_control`

Parameters:

```text
type
id
```

Returns the complete control plus a human-readable explanation.

For mappers, the explanation includes all rules in priority order.

### `create_control`

Common parameters:

```text
type
key
title?
description?
status?
```

Value-specific:

```text
value?
bot_name?
```

Mapper-specific:

```text
example?
rules?
```

Examples:

Toggle:

```json
{
  "type": "toggle",
  "key": "order-import",
  "title": "Order import",
  "description": "Controls whether new supplier spreadsheets may create orders.",
  "status": true
}
```

Value:

```json
{
  "type": "value",
  "key": "default-coupon",
  "description": "Fallback coupon for imported orders that do not match a mapper rule.",
  "value": "DEFAULT"
}
```

Mapper:

```json
{
  "type": "mapper",
  "key": "order-coupon",
  "description": "Maps imported order fields to a coupon object.",
  "example": {
    "destination": "jpn",
    "total": 120
  },
  "rules": []
}
```

### `update_control`

Parameters:

```text
type
id
patch
```

Only supplied patch fields change.

Toggle patch fields:

```text
status
enabled
title
description
```

Value patch fields:

```text
key
value
description
status
bot_name
botName
```

Mapper patch fields:

```text
key
title
description
example
rules
```

Supplying mapper `rules` replaces the complete ordered rule list.

### `flip_toggle`

Parameters:

```text
id
mode = on | off | flip
```

Use:

```text
on   -> explicitly enable
off  -> explicitly disable
flip -> invert current state
```

The AI is instructed not to use `flip` when the user said specifically on or off.

### `set_value`

Parameters:

```text
id
value
```

`id` may be the value token or key.

Also marks the value control status active.

### `delete_control`

Parameters:

```text
type
id
```

Deletion is recorded in history.

Deleting a value also invalidates its outstanding one-time setter links.

A deleted control can be restored through history while its history entry is retained.

### `evaluate_mapper`

Parameters:

```text
id
input
merge?
```

Read-only.

`merge=false`:

```json
{
  "coupon": "japan"
}
```

`merge=true`:

```json
{
  "destination": "jpn",
  "coupon": "japan"
}
```

The tool also returns whether a rule matched, the rule index, and rule name.

### `list_history`

Parameters:

```text
type?
id?
limit?
```

Returns newest-first history rows including:

- history id
- type
- stable control id
- human label
- action
- source
- before snapshot
- after snapshot
- compact from/to values
- timestamp

Stable history identifiers are:

```text
toggle -> key/botName
value  -> permanent value token
mapper -> permanent mapper token
```

### `revert_change`

Parameters:

```text
history_id
```

Reverts to the **before** snapshot of that exact history event.

Consequences:

```text
revert update -> restore previous state
revert delete -> recreate deleted control
revert create -> remove the created control
```

The revert itself becomes a new history entry.

## MCP resources

### `simple-toggle://guide`

Complete MCP operating guide.

### `simple-toggle://controls`

Complete current control inventory.

### `simple-toggle://history`

Recent history with before/after snapshots.

# Change history

Simple Toggle records mutations from:

```text
api
permanent
temporary
mcp
web
revert
```

For example, changing a permanent value through `/v/<token>` is recorded separately from changing it through MCP.

The browser **History** tab shows:

- time
- widget
- widget type
- source
- action
- compact before → after
- full before JSON
- full after JSON
- Revert button

History defaults to 100 rows per widget:

```json
{
  "historyLimit": 100
}
```

# Browser UI

The control panel has:

```text
Toggles
Values
Mappers
History
Notifications
```

Mapper editing includes:

- example JSON
- auto-generated field helpers
- nested AND/OR condition builder
- rule result JSON
- priority ordering
- example testing
- runtime URL copy

History includes the exact MCP endpoint URL with a copy button.

# Node.js client

Install from GitHub:

```bash
npm install github:vasilevich/simple-toggle
```

CommonJS:

```js
const BotControl = require('bots-status-manager');
```

ESM:

```js
import BotControl from 'bots-status-manager';
```

Configure:

```js
BotControl.configure({
  url: 'https://toggle.example.com',
  token: process.env.SIMPLE_TOGGLE_TOKEN
});
```

Or:

```js
BotControl.init(
  'https://toggle.example.com',
  process.env.SIMPLE_TOGGLE_TOKEN
);
```

The Node client uses the normal authenticated admin/value APIs.

MCP is separate and intentionally does not use this token.

# Practical example: Excel order imports

Suppose your importer receives:

```json
{
  "destination": "jpn",
  "total": 130,
  "customer": {
    "type": "normal"
  }
}
```

Instead of hardcoding coupon logic in the importer, create an `order-coupon` mapper in Simple Toggle.

Your importer only does:

```js
const mapped = await BotControl.mapByKey('order-coupon', order);

const finalOrder = {
  ...order,
  ...mapped
};
```

The business user can then change the rules from the web UI without changing the importer code.

The same mapper is also fully inspectable/editable through MCP, so an AI can answer:

```text
why would this order get coupon japan100?
```

or perform:

```text
make Japanese orders above 200 use coupon JAPAN200
```

by reading the mapper description/rules and updating the ordered rules.

# Server

Start:

```bash
npm start
```

Simple Toggle uses SQLite by default and can also use the existing Knex/MariaDB configuration.
