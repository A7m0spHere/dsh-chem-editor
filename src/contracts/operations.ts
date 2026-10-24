// v1 capabilities shared by the executor, tools, context and UI.
export const elements = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I'];
export const singleOperations = ['replace_atom', 'change_bond', 'attach_fragment', 'replace_fragment', 'delete_selection'];
export const operations = [...singleOperations, 'batch'];
export const bondTypes = [1, 2, 3];
export const batchLimits = { min: 2, max: 8 };
export const rejectionCodes = ['unsupported_fragment', 'unsupported_operation', 'connection_point_required', 'clarification_required', 'ambiguous_fragment'];
