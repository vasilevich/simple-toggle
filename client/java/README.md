# Simple Toggle Java 8 client

`SimpleToggleMapper.java` is a single dependency-free Java 8 file. Copy it into your project (and add your package declaration if needed).

The same client supports direct values, bot controls, temporary links, remote mapper operations, and local mapper evaluation.

```java
SimpleToggleMapper simpleToggle = new SimpleToggleMapper(
    "https://toggle.example.com",
    System.getenv("SIMPLE_TOGGLE_TOKEN")
);

Object coupon = simpleToggle.getValueByKey("coupon", "default", "orders");
simpleToggle.setValueByKey("coupon", "SALE", "orders");
Map<String, Object> values = simpleToggle.getValuesMap();
Object direct = simpleToggle.getValueOnlyValue(valueToken, "default");
```

The second constructor argument is the normal Simple Toggle admin token. List/key/administrative operations send `Authorization: Bearer <token>`. Permanent value/mapper token operations do not send it.

## Fetch configuration once, evaluate every row locally

```java
SimpleToggleMapper.MapperDefinition mapper = simpleToggle.getMapper("kish-orders-coupons");
for (Map<String, Object> order : orders) mapper.apply(order);

Map<String, Object> transformed = mapper.evaluate(order); // input unchanged
SimpleToggleMapper.EvaluationResult details = mapper.evaluateDetailed(order);
```

`details` exposes `output`, `changes`, `unsetFields`, `matchedRules`, and `matched()`. Rule/example getters return copies. The original constructor and local evaluator API remain available.

`getMapper(key)` caches by key in memory. It only performs HTTP when that key is not cached. To check for changes:

```java
mapper = simpleToggle.refreshMapper("kish-orders-coupons");
simpleToggle.invalidate("kish-orders-coupons");
simpleToggle.clearCache();
```

`refreshMapper` sends `If-None-Match`; unchanged definitions return HTTP `304`, and the existing cached instance is reused. Failed refreshes keep the previous cached definition. Refresh scheduling is up to the caller; row processing never performs HTTP.

## Permanent-token mode

```java
SimpleToggleMapper anonymous = new SimpleToggleMapper("https://toggle.example.com");
SimpleToggleMapper.MapperDefinition mapper = anonymous.getMapperByToken(mapperToken);
Object value = anonymous.getValueOnlyValue(valueToken, "default");
anonymous.setValue(valueToken, "updated");
```

`getMapperByToken` fetches without caching. A permanent mapper token is the credential for `GET /m/<token>`; a permanent value token is the credential for `GET/POST /v/<token>`. Key-based lookup uses `GET /m/key/<key>` and requires the admin token.

## Values, bot controls, and temporary links

```java
List<Map<String, Object>> controls = simpleToggle.getValuesByBot("orders");
Map<String, Object> control = simpleToggle.findValue("coupon", "orders");
Map<String, Object> valueResponse = simpleToggle.getValue(valueToken);
String permanentUrl = simpleToggle.getPermanentValueUrl(valueToken, true);
Map<String, Object> temporary = simpleToggle.createTemporarySetUrlByKey("coupon", "orders", 60);

SimpleToggleMapper.Bot bot = simpleToggle.bot("orders");
bot.enable();
bot.setStatus(true, java.util.Collections.<String, Object>singletonMap("title", "Orders"));
Map<String, Object> generated = bot.generateUrl("coupon", "Coupon code", "");
Map<String, Object> generatedTemporary = bot.generateTemporaryUrl("coupon", "Coupon code", "", 60);
```

The bot handle also supports `getStatus`, `disable`, `remove`, and `generateTempUrl`. Temporary-link expiry defaults to seven days; `0` requests no time expiry (the link is still one-time).

Default-value helpers preserve `false`, `0`, and empty strings; null/missing values use the default. `getValueOnlyValueNoEmptyOrNull` is string-only and also rejects blank strings, matching JS.

## Remote mapper administration and debugging

```java
Map<String, Object> config = new LinkedHashMap<String, Object>();
config.put("key", "orders");
config.put("rules", new ArrayList<Object>());
Map<String, Object> created = simpleToggle.createMapper(config);
simpleToggle.updateMapper((String) created.get("token"), config);

Map<String, Object> changes = simpleToggle.map(mapperToken, order);
Map<String, Object> output = simpleToggle.applyMap(mapperToken, order);
Map<String, Object> debug = simpleToggle.map(mapperToken, order, false, true); // merge, meta
```

`getMappers`, `findMapper`, `deleteMapper`, `mapRequest`, `mapByKey`, `applyMapByKey`, and `getMapperUrl` are also available. Remote evaluation is not needed for production row processing.

Response-style methods return maps containing `http_code` and `ok`. List/raw mapper methods throw `ApiException` on HTTP errors (`httpCode`, `data`); token default-value helpers return the fallback on request failure. `setTimeouts(connectMs, readMs)` configures HTTP timeouts. Streams and connections are closed after each request.

## Supported rules

Rules run top-to-bottom, skip `enabled: false`, and honor `afterMatch: "stop"` / `"continue"`. Conditions support nested AND/OR groups and `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `ends_with`, `in`, `not_in`, `exists`, `empty`, `not_empty`.

Set/unset actions support dot/array paths (`customer.type`, `items.0.sku`). Expressions support constants, field references, add/subtract/multiply/divide, concat, coalesce, and conditional if/then/else. Legacy `result` rules remain supported. JSON objects/arrays are represented as Java `Map`/`List`; numbers use Java numeric types.
