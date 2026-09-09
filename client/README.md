# Clients

Both clients support direct values, bot controls, temporary links, remote mapper management/evaluation, and cached mapper definitions evaluated locally.

| Feature | JavaScript (`js/`) | Java 8 (`java/`) |
| --- | --- | --- |
| Client | `BotControl.configure({url, token})` | `new SimpleToggleMapper(url, token)` |
| List/read/write values | `getValues`, `getValuesMap`, `getValue`, `setValue`, `deleteValue` | Same instance method names |
| Key and bot filtering | `findValue`, `getValuesByBot`, `getValueByKey`, `setValueByKey` | Same instance method names |
| Raw value/default helpers | `getValueOnlyValue`, `getValueOnlyValueNoEmptyOrNull` | Same instance method names |
| Value links | `getPermanentValueUrl`, `createTemporarySetUrl`, `createTemporarySetUrlByKey` | Same instance method names |
| Bot-scoped handle | `new BotControl(botName)` | `client.bot(botName)` |
| Bot operations | `getStatus`, `setStatus`, `enable`, `disable`, `remove`, `generateUrl`, `generateTemporaryUrl`, `generateTempUrl` | Same methods on the bot handle |
| Mapper administration | `getMappers`, `findMapper`, `createMapper`, `updateMapper`, `deleteMapper` | Same instance method names |
| Remote evaluation | `map`, `mapRequest`, `applyMap`, `mapByKey`, `applyMapByKey`, `getMapperUrl` | Same names; `merge`/`meta` boolean overloads instead of an options object |
| Local definitions | `getMapper`, `refreshMapper`, `getMapperByToken`, `invalidate`, `clearCache` | Same instance method names |
| Local execution | `mapper.evaluate`, `mapper.apply`, `mapper.evaluateDetailed` | Same method names |

See the [JavaScript examples](js/README.md) and [Java examples](java/README.md).

## Shared behavior

Key/list/administrative operations require the admin Bearer token. Permanent value and mapper tokens are credentials themselves, so their read/write/evaluate requests do not require or transmit the admin token.

`getMapper(key)` caches the definition; `refreshMapper(key)` explicitly revalidates using ETag and reuses the cached instance on HTTP 304. `getMapperByToken(token)` fetches a definition without caching it. `evaluate` and `evaluateDetailed` deep-copy the input; `apply` mutates it in place. None of those three evaluation methods performs HTTP. Disabled rules are skipped; matching rules honor stop/continue.

Value lookups preserve `false`, `0`, and empty strings. Defaults apply to null/missing values. The `NoEmptyOrNull` helper is intentionally string-only, matching the existing JS API. Lists preserve server order; `getValuesMap()` keeps the newest duplicate key.

Java returns `Map`/`List` JSON values, and JS returns objects/arrays. Response-style helpers include `http_code` and `ok`; list/raw mapper methods throw on HTTP errors. Java errors expose `ApiException.httpCode` and `data`; JS errors expose `http_code` and `data`. Default-value token helpers return the fallback on request failure.

## Migration

Package-root imports (`require('bots-status-manager')` / `import ... from 'bots-status-manager'`) are unchanged. Repository-relative JS paths move from `client/index.*` to `client/js/index.*`; the single Java source moves from `java/SimpleToggleMapper.java` to `client/java/SimpleToggleMapper.java`.
