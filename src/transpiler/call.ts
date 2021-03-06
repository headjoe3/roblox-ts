import * as ts from "ts-morph";
import { transpileArguments, transpileExpression, validateApiAccess } from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";
import { isArrayType, isTupleType } from "../typeUtilities";

const STRING_MACRO_METHODS = [
	"byte",
	"find",
	"format",
	"gmatch",
	"gsub",
	"len",
	"lower",
	"match",
	"rep",
	"reverse",
	"sub",
	"upper",
];

const RBX_MATH_CLASSES = ["CFrame", "UDim", "UDim2", "Vector2", "Vector2int16", "Vector3", "Vector3int16"];

export function transpileCallExpression(state: TranspilerState, node: ts.CallExpression, doNotWrapTupleReturn = false) {
	const exp = node.getExpression();
	if (ts.TypeGuards.isPropertyAccessExpression(exp)) {
		return transpilePropertyCallExpression(state, node, doNotWrapTupleReturn);
	} else if (ts.TypeGuards.isSuperExpression(exp)) {
		let params = transpileArguments(state, node.getArguments() as Array<ts.Expression>);
		if (params.length > 0) {
			params = ", " + params;
		}
		params = "self" + params;
		const className = exp
			.getType()
			.getSymbolOrThrow()
			.getName();
		return `${className}.constructor(${params})`;
	} else {
		const callPath = transpileExpression(state, exp);
		const params = transpileArguments(state, node.getArguments() as Array<ts.Expression>);
		let result = `${callPath}(${params})`;
		if (!doNotWrapTupleReturn && isTupleType(node.getReturnType())) {
			result = `{ ${result} }`;
		}
		return result;
	}
}

export function transpilePropertyCallExpression(
	state: TranspilerState,
	node: ts.CallExpression,
	doNotWrapTupleReturn = false,
) {
	const expression = node.getExpression();
	if (!ts.TypeGuards.isPropertyAccessExpression(expression)) {
		throw new TranspilerError(
			"Expected PropertyAccessExpression",
			node,
			TranspilerErrorType.ExpectedPropertyAccessExpression,
		);
	}
	validateApiAccess(state, expression.getNameNode());
	const subExp = expression.getExpression();
	const subExpType = subExp.getType();
	let accessPath = transpileExpression(state, subExp);
	const property = expression.getName();
	let params = transpileArguments(state, node.getArguments() as Array<ts.Expression>);

	if (isArrayType(subExpType)) {
		let paramStr = accessPath;
		if (params.length > 0) {
			paramStr += ", " + params;
		}
		state.usesTSLibrary = true;
		return `TS.array_${property}(${paramStr})`;
	}

	if (subExpType.isString() || subExpType.isStringLiteral()) {
		let paramStr = accessPath;
		if (params.length > 0) {
			paramStr += ", " + params;
		}
		if (STRING_MACRO_METHODS.indexOf(property) !== -1) {
			return `string.${property}(${paramStr})`;
		}
		state.usesTSLibrary = true;
		return `TS.string_${property}(${paramStr})`;
	}

	const subExpTypeSym = subExpType.getSymbol();
	if (subExpTypeSym && ts.TypeGuards.isPropertyAccessExpression(expression)) {
		const subExpTypeName = subExpTypeSym.getEscapedName();

		// custom promises
		if (subExpTypeName === "Promise") {
			if (property === "then") {
				return `${accessPath}:andThen(${params})`;
			}
		}

		// for is a reserved word in Lua
		if (subExpTypeName === "SymbolConstructor") {
			if (property === "for") {
				return `${accessPath}.getFor(${params})`;
			}
		}

		if (subExpTypeName === "Map" || subExpTypeName === "ReadonlyMap" || subExpTypeName === "WeakMap") {
			let paramStr = accessPath;
			if (params.length > 0) {
				paramStr += ", " + params;
			}
			state.usesTSLibrary = true;
			return `TS.map_${property}(${paramStr})`;
		}

		if (subExpTypeName === "Set" || subExpTypeName === "ReadonlySet" || subExpTypeName === "WeakSet") {
			let paramStr = accessPath;
			if (params.length > 0) {
				paramStr += ", " + params;
			}
			state.usesTSLibrary = true;
			return `TS.set_${property}(${paramStr})`;
		}

		if (subExpTypeName === "ObjectConstructor") {
			state.usesTSLibrary = true;
			return `TS.Object_${property}(${params})`;
		}

		const validateMathCall = () => {
			if (ts.TypeGuards.isExpressionStatement(node.getParent())) {
				throw new TranspilerError(
					`${subExpTypeName}.${property}() cannot be an expression statement!`,
					node,
					TranspilerErrorType.NoMacroMathExpressionStatement,
				);
			}
		};

		// custom math
		if (RBX_MATH_CLASSES.indexOf(subExpTypeName) !== -1) {
			switch (property) {
				case "add":
					validateMathCall();
					return `(${accessPath} + (${params}))`;
				case "sub":
					validateMathCall();
					return `(${accessPath} - (${params}))`;
				case "mul":
					validateMathCall();
					return `(${accessPath} * (${params}))`;
				case "div":
					validateMathCall();
					return `(${accessPath} / (${params}))`;
			}
		}
	}

	const symbol = expression.getType().getSymbol();

	const isSuper = ts.TypeGuards.isSuperExpression(subExp);

	let sep = ".";
	if (
		symbol &&
		symbol
			.getDeclarations()
			.some(dec => ts.TypeGuards.isMethodDeclaration(dec) || ts.TypeGuards.isMethodSignature(dec))
	) {
		if (isSuper) {
			const className = subExp
				.getType()
				.getSymbolOrThrow()
				.getName();
			accessPath = className + ".__index";
			params = "self" + (params.length > 0 ? ", " : "") + params;
		} else {
			sep = ":";
		}
	}

	let result = `${accessPath}${sep}${property}(${params})`;
	if (!doNotWrapTupleReturn && isTupleType(node.getReturnType())) {
		result = `{ ${result} }`;
	}
	return result;
}
