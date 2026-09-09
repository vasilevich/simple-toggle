import BotControl, {BotControl as NamedClient, MapperDefinition, MapperEvaluationResult, ValueControl} from 'bots-status-manager';

BotControl.configure({url: 'https://example.test'});
NamedClient.init('https://example.test', 'admin');
const values: Promise<ValueControl[]> = BotControl.getValues();
const cached: Promise<MapperDefinition> = BotControl.getMapper('orders');
const anonymous: Promise<MapperDefinition> = BotControl.getMapperByToken('token');
const mapper = new MapperDefinition({rules: [{enabled: false, result: {discount: 10}}]});
const result: MapperEvaluationResult = mapper.evaluateDetailed({price: 100});
const row = mapper.apply({price: 100});
const refreshed: Promise<MapperDefinition> = BotControl.refreshMapper('orders');
const constructor: typeof MapperDefinition = BotControl.MapperDefinition;
BotControl.invalidate('orders');
BotControl.clearCache();
void [values, cached, anonymous, result, row, refreshed, constructor];
