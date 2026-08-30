export interface BotControlConfig {
    url: string;
    token: string;
}

export interface ApiResult {
    http_code: number;
    ok: boolean;
    [key: string]: any;
}

export interface ValueControl {
    key: string;
    value: any;
    description?: string;
    status?: boolean;
    token: string;
    botName?: string;
    bot_name?: string;
    updatedAt?: string;
    createdAt?: string;
}

export interface BotStatus {
    botName: string;
    title?: string;
    description?: string;
    status: boolean;
}

export interface TemporarySetLink extends ApiResult {
    code?: string;
    url?: string;
    expires_at?: string | null;
    one_time?: boolean;
}

export default class BotControl {
    static url: string;
    static token: string;
    static DEFAULT_TEMP_LINK_MINUTES: number;

    constructor(botName: string);

    static configure(config: BotControlConfig): typeof BotControl;
    static configure(url: string, token: string): typeof BotControl;
    static init(url: string, token: string): typeof BotControl;
    static getAuthorizationHeader(): {Authorization: string};
    static getRequest(fullUrl: string): Promise<ApiResult>;
    static deleteRequest(fullUrl: string): Promise<ApiResult>;
    static postRequest(fullUrl: string, obj?: any): Promise<ApiResult>;

    static getValues(): Promise<ValueControl[]>;
    static getValuesMap(): Promise<Record<string, any>>;
    static getValuesByBot(botName: string): Promise<ValueControl[]>;
    static findValue(key: string, botName?: string | null): Promise<ValueControl | null>;
    static getValueByKey(key: string, defaultValue?: any, botName?: string | null): Promise<any>;
    static setValueByKey(key: string, value: any, botName?: string | null): Promise<ApiResult>;
    static createTemporarySetUrl(valueToken: string, expiresInMinutes?: number): Promise<TemporarySetLink>;
    static createTemporarySetUrlByKey(key: string, botName?: string | null, expiresInMinutes?: number): Promise<TemporarySetLink>;
    static getBots(): Promise<BotStatus[]>;

    generateUrl(key: string, description?: string, value?: any): Promise<ApiResult & {
        set_value_url?: string | null;
        get_value_url?: string | null;
        user_url?: string | null;
    }>;
    generateTemporaryUrl(key: string, description?: string, value?: any, expiresInMinutes?: number): Promise<ApiResult & {
        temporary_url?: string | null;
        temporary_code?: string | null;
        temporary_expires_at?: string | null;
        temporary_http_code?: number;
        temporary_ok?: boolean;
    }>;
    generateTempUrl(key: string, description?: string, value?: any, expiresInMinutes?: number): ReturnType<BotControl['generateTemporaryUrl']>;

    static setValue(token: string, value: any): Promise<ApiResult>;
    static getValue(token: string): Promise<ApiResult>;
    static getValueOnlyValue(token: string, defaultValue?: any): Promise<any>;
    static getValueOnlyValueNoEmptyOrNull(token: string, defaultValue?: any): Promise<any>;
    static deleteValue(token: string): Promise<ApiResult>;

    getStatus(): Promise<ApiResult>;
    setStatus(status: boolean, extra?: Record<string, any>): Promise<ApiResult>;
    enable(): Promise<ApiResult>;
    disable(): Promise<ApiResult>;
    remove(): Promise<ApiResult>;
}

export {BotControl};
