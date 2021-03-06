import * as ts from "ts-morph";
import { transpileExpression } from ".";
import { TranspilerState } from "../TranspilerState";

export function transpileTypeOfExpression(state: TranspilerState, node: ts.TypeOfExpression) {
	const expStr = transpileExpression(state, node.getExpression());
	state.usesTSLibrary = true;
	return `TS.typeof(${expStr})`;
}
