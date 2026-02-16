var damlTypes = require('@daml/types');
var Record = { templateId: '#my-project:OtherModule:Record' };
damlTypes.registerTemplate(Record);
exports.Record = Record;
