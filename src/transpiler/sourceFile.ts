import * as ts from "ts-morph";
import { transpileStatementedNode } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { getScriptContext, getScriptType, ScriptType } from "../utility";

const IMP_STR = `local TS = require(
	game:GetService("ReplicatedStorage")
		:WaitForChild("RobloxTS")
		:WaitForChild("Include")
		:WaitForChild("RuntimeLib")
);\n`;

export function transpileSourceFile(state: TranspilerState, node: ts.SourceFile) {
	state.scriptContext = getScriptContext(node);
	const scriptType = getScriptType(node);

	let result = "";
	result += transpileStatementedNode(state, node);
	if (state.isModule) {
		if (scriptType !== ScriptType.Module) {
			throw new TranspilerError(
				"Attempted to export in a non-ModuleScript!",
				node,
				TranspilerErrorType.ExportInNonModuleScript,
			);
		}

		let hasExportEquals = false;
		for (const Descendant of node.getDescendantsOfKind(ts.SyntaxKind.ExportAssignment)) {
			if (hasExportEquals) {
				throw new TranspilerError(
					"ModuleScript contains multiple ExportEquals. You can only do `export = ` once.",
					node,
					TranspilerErrorType.MultipleExportEquals,
				);
			}
			if (Descendant.isExportEquals()) {
				hasExportEquals = true;
			}
		}

		if (hasExportEquals) {
			result = state.indent + `local _exports;\n` + result;
		} else {
			result = state.indent + `local _exports = {};\n` + result;
		}
		result += state.indent + "return _exports;\n";
	} else {
		if (scriptType === ScriptType.Module) {
			result += state.indent + "return nil;\n";
		}
	}
	if (state.usesTSLibrary) {
		result = state.indent + IMP_STR + result;
	}
	return result;
}
