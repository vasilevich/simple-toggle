# Simple Toggle Java 8 mapper client

`SimpleToggleMapper.java` is a single dependency-free Java 8 file. Copy it into your project (and add your package declaration if needed).

The important architecture is: **fetch configuration once, evaluate every row locally**.

```java
SimpleToggleMapper simpleToggle = new SimpleToggleMapper(
    "https://toggle.example.com",
    System.getenv("SIMPLE_TOGGLE_TOKEN")
);

SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapper("kish-orders-coupons");

for (Map<String, Object> order : orders) {
    mapper.apply(order); // local only: no HTTP here
}
```

The second constructor argument is the normal Simple Toggle admin token. `getMapper(key)` and `refreshMapper(key)` send it as:

```text
Authorization: Bearer <token>
```

Or keep the input unchanged:

```java
Map<String, Object> transformed = mapper.evaluate(order);
```

`getMapper(key)` caches by key in memory. It only performs HTTP when that key is not cached.

When you decide it is time to check for changes:

```java
mapper = simpleToggle.refreshMapper("kish-orders-coupons");
```

`refreshMapper` sends `If-None-Match`; unchanged definitions return HTTP `304`, so the existing cached instance is reused.

You choose when refresh happens: once per import, once every N minutes, application startup, etc. Row processing never depends on Simple Toggle being reachable.

## Permanent mapper token mode

If you already have the mapper's permanent mapper token, you can use it as the credential without the global admin token:

```java
SimpleToggleMapper simpleToggle = new SimpleToggleMapper("https://toggle.example.com");
SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapperByToken(mapperToken);
```

So the split is:

```text
getMapper("mapper-key")          -> requires global admin Bearer token
refreshMapper("mapper-key")      -> requires global admin Bearer token
getMapperByToken(mapperToken)     -> mapper token itself is the credential
```

## Supported rules

Rules run top-to-bottom. Each matched rule has:

- `afterMatch: "stop"` — do not inspect later rules
- `afterMatch: "continue"` — continue, allowing later rules to overwrite earlier changes

Conditions support nested AND/OR groups and:

`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `ends_with`, `in`, `not_in`, `exists`, `empty`, `not_empty`.

Actions:

- set a field
- unset a field

Set expressions support:

- constants
- field references
- add
- subtract
- multiply
- divide
- concat
- coalesce/default
- conditional if/then/else

Dot paths are supported, e.g. `customer.type` or `items.0.sku`.

## Example calculation

A rule created in the web UI can represent:

```text
IF category = kspflight
THEN
    coupon = "kspflight"
    sumOfInsurance = sumOfInsurance - (passengerCount * 20)
CONTINUE
```

The Java evaluator executes that entirely in memory for every order.

## Mapper definition URLs

Key-based lookup requires the normal admin token:

```text
GET /m/key/<mapper-key>
Authorization: Bearer <admin-token>
```

A permanent mapper token can be fetched directly because the token itself is the credential:

```text
GET /m/<permanent-mapper-token>
```

Both return `ETag` and `Last-Modified` headers for clean caching/revalidation.

Server-side `POST /m/<token>` still exists for debugging/testing, but it is not required for production row processing.
