import * as damlTypes from '@daml/types';

export declare const Asset: damlTypes.Template<{owner: string; name: string; value: string}, undefined, string>;
export declare const AssetTransfer: damlTypes.Template<{asset: string; owner: string; newOwner: string}, undefined, string>;
