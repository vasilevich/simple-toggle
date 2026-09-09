# JavaScript client

Node.js 18+, with CommonJS, ESM, and TypeScript declarations. The client itself uses only built-in APIs.

```js
const BotControl = require('bots-status-manager');
// Or: import BotControl, {MapperDefinition} from 'bots-status-manager';

BotControl.configure({url: 'https://toggle.example.com', token: process.env.SIMPLE_TOGGLE_TOKEN});

const values = await BotControl.getValuesMap();
const coupon = await BotControl.getValueByKey('coupon', 'default', 'orders');
await BotControl.setValueByKey('coupon', 'SALE', 'orders');
const direct = await BotControl.getValueOnlyValue(valueToken, 'default');
```

## Fetch once, evaluate locally

```js
let mapper = await BotControl.getMapper('orders-coupons');
for (const order of orders) mapper.apply(order);

const transformed = mapper.evaluate(order);        // independent deep copy
const details = mapper.evaluateDetailed(order);    // output, changes, unsetFields, matchedRules
mapper = await BotControl.refreshMapper('orders-coupons'); // ETag/304 revalidation
BotControl.invalidate('orders-coupons');
BotControl.clearCache();
```

`getMapper` caches by key and coalesces concurrent fetches. Refresh is explicit. Reconfiguration clears the cache, and invalidated/reconfigured in-flight requests cannot repopulate it. Failed refreshes do not replace the last successful definition.

Definitions expose `getKey`, `getTitle`, `getDescription`, `getToken`, `getRevision`, `getEtag`, `getExample`, and `getRules`. Example/rule getters return copies. For an already downloaded definition, use `new MapperDefinition(definition)` (also available as `BotControl.MapperDefinition`).

The evaluator supports all server condition operators, nested AND/OR groups, set/unset, dot/array paths, arithmetic, concat, coalesce, conditional expressions, legacy result rules, disabled rules, and stop/continue. The server imports this same implementation.

## Permanent-token access

```js
BotControl.configure('https://toggle.example.com');
const mapper = await BotControl.getMapperByToken(mapperToken);
const value = await BotControl.getValueOnlyValue(valueToken, 'default');
await BotControl.setValue(valueToken, 'updated');
```

These requests use the permanent token in the URL, without sending an admin token. Key lookups and administration still require admin configuration.

## Bot controls, links, and remote mappers

```js
BotControl.configure('https://toggle.example.com', process.env.SIMPLE_TOGGLE_TOKEN);
const bot = new BotControl('orders');
await bot.enable();
const generated = await bot.generateUrl('coupon', 'Coupon code', '');
const temporary = await bot.generateTemporaryUrl('coupon', 'Coupon code', '', 60);
const link = await BotControl.createTemporarySetUrlByKey('coupon', 'orders', 60);

const mappers = await BotControl.getMappers();
const created = await BotControl.createMapper({key: 'orders', rules: []});
await BotControl.updateMapper(created.token, {title: 'Orders'});
const changes = await BotControl.map(mapperToken, order);
const output = await BotControl.applyMap(mapperToken, order);
const debug = await BotControl.map(mapperToken, order, {meta: true});
```

Remote evaluation is for debugging/convenience; use downloaded definitions for bulk processing. `mapRequest` returns response metadata (`http_code`, `ok`); `map` returns the raw JSON result and throws on HTTP failure.
