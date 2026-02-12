var damlTypes = require('@daml/types');
var Asset = { templateId: '#my-project:MyModule:Asset' };
damlTypes.registerTemplate(Asset);
var AssetTransfer = { templateId: '#my-project:MyModule:AssetTransfer' };
damlTypes.registerTemplate(AssetTransfer);
exports.Asset = Asset;
exports.AssetTransfer = AssetTransfer;
