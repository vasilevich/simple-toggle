# Simple Toggle

Simple Toggle is a small self-hosted control plane for runtime configuration.

It stores and lets humans edit:

- boolean **Toggles**
- editable **Values**
- ordered **Rules / Condition Mappers**
- rolling reversible history
- an unauthenticated MCP interface

For rules/mappers, Simple Toggle is intentionally the **configuration/control plane**, not the high-volume execution engine.

A consuming application should fetch a mapper definition once, cache it, and evaluate as many rows/orders as it wants locally.

```text
Simple Toggle
    |
    | fetch mapper definition once
    v
local client evaluator
    |
    +--> row 1
    +--> row 2
    +--> row 3
    +--> ...
```

Do **not** send every production row to Simple Toggle.

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

Default control panel:

```text
http://127.0.0.1:3000/?token=1234567890
```

Default MCP endpoint:

```text
http://127.0.0.1:3000/mcp
```

This repository uses npm. There is intentionally no `yarn.lock`.

# Rules / Condition Mappers

A mapper is an ordered list of business rules. It can inspect an input object, set/unset fields, calculate values, and optionally continue into later rules.

Example business logic:

```text
IF category = "kspflight"
THEN
    coupon = "kspflight"
    sumOfInsurance = sumOfInsurance - (passengerCount * 20)
CONTINUE
```

Another rule later can overwrite earlier values:

```text
IF category = "ksporganized"
AND sumInShekels > 30000
THEN
    coupon = null
    warning = "Customers more than 30k shekel per customer"
    state = "POLISA_PROBLEM"
STOP
```

The web UI builds these visually. Normal users do not need to edit JSON.

## Rule execution

Rules run from top to bottom.

Each rule has an `afterMatch` behavior:

- `stop` — stop processing later rules after this rule matches
- `continue` — execute the actions, then allow later rules to match and overwrite fields

This makes it possible to reproduce ordinary imperative business logic without hardcoding it back into Java.

Older mapper definitions using the v1 `result` object are still accepted. They are normalized into constant `set` actions and default to `stop`.

## Conditions

Conditions support nested AND / OR groups and dot paths such as:

```text
customer.type
items.0.sku
```

Operators:

- `eq`
- `neq`
- `gt`
- `gte`
- `lt`
- `lte`
- `contains`
- `starts_with`
- `ends_with`
- `in`
- `not_in`
- `exists`
- `empty`
- `not_empty`

An empty AND group matches always. An empty OR group matches never.

## Actions

Rules currently support:

```text
Set field
Unset field
```

A set action can use a structured expression rather than only a constant.

## Expressions

Expression types:

- constant
- field reference
- add
- subtract
- multiply
- divide
- concat
- coalesce/default
- conditional if/then/else

Example serialized expression for:

```text
sumOfInsurance - (passengerCount * 20)
```

```json
{
  "type": "op",
  "op": "subtract",
  "args": [
    {"type": "field", "path": "sumOfInsurance"},
    {
      "type": "op",
      "op": "multiply",
      "args": [
        {"type": "field", "path": "passengerCount"},
        {"type": "const", "value": 20}
      ]
    }
  ]
}
```

The browser UI creates this structure with dropdowns and nested expression controls.

## Canonical rule shape

```json
{
  "name": "Flight insurance discount",
  "when": {
    "type": "condition",
    "field": "category",
    "operator": "eq",
    "value": "kspflight"
  },
  "actions": [
    {
      "type": "set",
      "field": "coupon",
      "value": {"type": "const", "value": "kspflight"}
    },
    {
      "type": "set",
      "field": "sumOfInsurance",
      "value": {
        "type": "op",
        "op": "subtract",
        "args": [
          {"type": "field", "path": "sumOfInsurance"},
          {
            "type": "op",
            "op": "multiply",
            "args": [
              {"type": "field", "path": "passengerCount"},
              {"type": "const", "value": 20}
            ]
          }
        ]
      }
    }
  ],
  "afterMatch": "continue"
}
```

# Fetching mapper definitions

Mapper definitions are available without the admin token through read-only distribution URLs:

```text
GET /m/key/<mapper-key>
GET /m/<permanent-mapper-token>
```

For example:

```text
GET /m/key/kish-orders-coupons
```

The response contains:

- `definitionVersion`
- `revision`
- key/title/description
- example object
- normalized rules/actions/expressions
- timestamps

Definition responses include:

```text
ETag
Last-Modified
Cache-Control: public, max-age=0, must-revalidate
```

Clients can therefore keep a local definition and periodically revalidate cheaply with `If-None-Match`.

# Java 8 local evaluator

A dependency-free Java 8 implementation is included at:

```text
java/SimpleToggleMapper.java
```

There is no Maven/Gradle dependency requirement. Copy the single file into your Java project and add your package declaration if needed.

Basic usage:

```java
SimpleToggleMapper simpleToggle =
    new SimpleToggleMapper("https://toggle.example.com");

SimpleToggleMapper.MapperDefinition mapper =
    simpleToggle.getMapper("kish-orders-coupons");

for (Map<String, Object> order : orders) {
    mapper.apply(order);
}
```

`getMapper(key)` fetches the definition the first time and caches it in memory.

`mapper.apply(order)` performs **no HTTP**. It executes conditions/actions/expressions locally.

If you want a transformed copy instead of mutating the original:

```java
Map<String, Object> transformed = mapper.evaluate(order);
```

When you choose to check for rule changes:

```java
mapper = simpleToggle.refreshMapper("kish-orders-coupons");
```

`refreshMapper` sends `If-None-Match`. If the configuration did not change, Simple Toggle returns `304` and the cached mapper instance is reused.

You decide the refresh policy: once per import, application startup, every few minutes, etc.

See `java/README.md` for the compact Java-specific guide.

# Server-side mapper evaluation

Server-side evaluation still exists as a debugging/convenience feature:

```text
POST /m/<mapper-token>
POST /bot/mappers/<mapper-token>/test
```

It is **not required** for normal production processing.

The intended production path is local evaluation in Java/Node/Python/etc.

# Values

Values are editable remote single-value controls.

Permanent value API:

```text
GET  /v/<permanent-value-token>
POST /v/<permanent-value-token>
```

Node client example:

```js
const BotControl = require('bots-status-manager');

BotControl.configure({
  url: 'https://toggle.example.com',
  token: process.env.SIMPLE_TOGGLE_TOKEN
});

const value = await BotControl.getValueByKey('feature_message', 'default');
await BotControl.setValueByKey('feature_message', 'hello');
```

# Toggles

```js
const worker = new BotControl('worker-name');

await worker.enable();
await worker.disable();
const status = await worker.getStatus();
```

# Change history

Changes made through the web UI, APIs, permanent/temporary value links, mapper editing, and MCP are recorded as before/after snapshots.

History defaults to the newest 100 entries per control (`historyLimit`).

The History tab shows:

- timestamp
- source
- before/after state
- compact from → to summary
- revert button

Reverting a deletion restores the deleted widget. Reverting a creation removes it again. Reverts themselves are also recorded.

# MCP

Simple Toggle exposes an intentionally unauthenticated Streamable HTTP MCP endpoint:

```text
https://toggle.example.com/mcp
```

No bearer token, API key, OAuth, or custom authorization header is required for MCP.

Anyone who can reach `/mcp` can inspect and mutate Simple Toggle, so network access to this endpoint is the security boundary.

The MCP server exposes tools for:

- listing/searching/explaining controls
- creating/updating/deleting controls
- flipping toggles
- setting values
- reading/editing mapper definitions
- test-evaluating mappers
- history and revert

Mapper definitions exposed through MCP use the same v2 rules/actions/expression format described above. MCP/server evaluation is useful for tests; production bulk row processing should still fetch the definition and execute it locally.

# Configuration

`config/default.json` contains the normal server configuration:

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

`/mcp` is intentionally unauthenticated.
