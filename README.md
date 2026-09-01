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

Mapper-by-key lookup uses the normal Simple Toggle admin token:

```text
GET /m/key/<mapper-key>
Authorization: Bearer <admin-token>
```

A permanent mapper token can be used directly as its own credential:

```text
GET /m/<permanent-mapper-token>
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
SimpleToggleMapper simpleToggle = new SimpleToggleMapper(
    "https://toggle.example.com",
    System.getenv("SIMPLE_TOGGLE_TOKEN")
);

SimpleToggleMapper.MapperDefinition mapper =
    simpleToggle.getMapper("kish-orders-coupons");

for (Map<String, Object> order : orders) {
    mapper.apply(order); // entirely local; no HTTP here
}
```

The second constructor argument is the same token used by the normal Simple Toggle web/admin API. The Java client sends it as a Bearer token only when fetching/revalidating a mapper by key.

`getMapper(key)` fetches the definition the first time and caches it in memory. `refreshMapper(key)` revalidates with the same Bearer token plus `If-None-Match`.

If you already have the permanent mapper token, the global admin token is optional:

```java
SimpleToggleMapper simpleToggle = new SimpleToggleMapper("https://toggle.example.com");
SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapperByToken(mapperToken);
```

That permanent mapper token is the credential for `/m/<mapper-token>`.
