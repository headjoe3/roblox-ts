import * as ts from "ts-morph";
import {
	checkMethodReserved,
	checkReserved,
	inheritsFromRoact,
	ROACT_COMPONENT_TYPE,
	ROACT_PURE_COMPONENT_TYPE,
	transpileAccessorDeclaration,
	transpileConstructorDeclaration,
	transpileExpression,
	transpileMethodDeclaration,
	transpileRoactClassDeclaration,
} from ".";
import { TranspilerError, TranspilerErrorType } from "../errors/TranspilerError";
import { TranspilerState } from "../TranspilerState";

const LUA_RESERVED_METAMETHODS = [
	"__index",
	"__newindex",
	"__add",
	"__sub",
	"__mul",
	"__div",
	"__mod",
	"__pow",
	"__unm",
	"__eq",
	"__lt",
	"__le",
	"__call",
	"__concat",
	"__tostring",
	"__len",
	"__metatable",
	"__mode",
];

const LUA_UNDEFINABLE_METAMETHODS = ["__index", "__newindex", "__mode"];

function getClassMethod(
	classDec: ts.ClassDeclaration | ts.ClassExpression,
	methodName: string,
): ts.MethodDeclaration | undefined {
	const method = classDec.getMethod(methodName);
	if (method) {
		return method;
	}
	const baseClass = classDec.getBaseClass();
	if (baseClass) {
		const baseMethod = getClassMethod(baseClass, methodName);
		if (baseMethod) {
			return baseMethod;
		}
	}
	return undefined;
}

// TODO: remove
function getConstructor(node: ts.ClassDeclaration | ts.ClassExpression) {
	for (const constructor of node.getConstructors()) {
		return constructor;
	}
}

function transpileClass(state: TranspilerState, node: ts.ClassDeclaration | ts.ClassExpression) {
	const name = node.getName() || state.getNewId();
	const nameNode = node.getNameNode();
	if (nameNode) {
		checkReserved(name, nameNode);
	}

	if (ts.TypeGuards.isClassDeclaration(node)) {
		state.pushExport(name, node);
	}

	const baseTypes = node.getBaseTypes();
	for (const baseType of baseTypes) {
		const baseTypeText = baseType.getText();

		// Handle the special case where we have a roact class
		if (baseTypeText.startsWith(ROACT_COMPONENT_TYPE)) {
			return transpileRoactClassDeclaration(state, "Component", name, node);
		} else if (baseTypeText.startsWith(ROACT_PURE_COMPONENT_TYPE)) {
			return transpileRoactClassDeclaration(state, "PureComponent", name, node);
		}

		if (inheritsFromRoact(baseType)) {
			throw new TranspilerError(
				"Derived Classes are not supported in Roact!",
				node,
				TranspilerErrorType.RoactSubClassesNotSupported,
			);
		}
	}

	const isExpression = ts.TypeGuards.isClassExpression(node);

	let result = "";
	if (isExpression) {
		result += `(function()\n`;
	} else {
		result += state.indent + `do\n`;
		state.hoistStack[state.hoistStack.length - 1].add(name);
	}
	state.pushIndent();

	let baseClassName = "";
	const extendsClause = node.getHeritageClauseByKind(ts.SyntaxKind.ExtendsKeyword);
	if (extendsClause) {
		const typeNode = extendsClause.getTypeNodes()[0];
		if (typeNode) {
			baseClassName = transpileExpression(state, typeNode.getExpression());
		}
	}

	const id = name;
	let hasStaticMembers = false;
	let hasStaticInheritance = false;
	let hasInstanceInheritance = false;
	let currentBaseClass = node.getBaseClass();

	while (currentBaseClass) {
		if (
			currentBaseClass.getStaticMembers().length > 0 ||
			currentBaseClass.getStaticProperties().length > 0 ||
			currentBaseClass.getStaticMethods().length > 0
		) {
			hasStaticInheritance = true;
		}

		if (
			currentBaseClass.getInstanceMembers().length > 0 ||
			currentBaseClass.getInstanceProperties().length > 0 ||
			currentBaseClass.getInstanceMethods().length > 0
		) {
			hasInstanceInheritance = true;
		}

		currentBaseClass = currentBaseClass.getBaseClass();
	}

	if (hasStaticInheritance || hasInstanceInheritance) {
		result += state.indent + `local super = ${baseClassName};\n`;
	}

	let prefix = "";
	if (isExpression) {
		prefix = `local `;
	}

	if (hasStaticInheritance) {
		result += state.indent + prefix + `${id} = setmetatable({`;
	} else {
		result += state.indent + prefix + `${id} = {`;
	}

	state.pushIndent();

	node.getStaticMethods()
		.filter(method => method.getBody() !== undefined)
		.forEach(method => {
			if (!hasStaticMembers) {
				hasStaticMembers = true;
				result += "\n";
			}
			result += state.indent + transpileMethodDeclaration(state, method);
		});

	state.popIndent();

	if (hasStaticInheritance) {
		result += `${hasStaticMembers ? state.indent : ""}}, {__index = super});\n`;
	} else {
		result += `${hasStaticMembers ? state.indent : ""}};\n`;
	}

	if (hasInstanceInheritance) {
		result += state.indent + `${id}.__index = setmetatable({`;
	} else {
		result += state.indent + `${id}.__index = {`;
	}

	state.pushIndent();
	let hasIndexMembers = false;

	const extraInitializers = new Array<string>();
	const instanceProps = node
		.getInstanceProperties()
		// @ts-ignore
		.filter(prop => prop.getParent() === node)
		.filter(prop => !ts.TypeGuards.isGetAccessorDeclaration(prop))
		.filter(prop => !ts.TypeGuards.isSetAccessorDeclaration(prop));
	for (const prop of instanceProps) {
		const propName = prop.getName();
		if (propName) {
			checkMethodReserved(propName, prop);

			if (ts.TypeGuards.isInitializerExpressionableNode(prop)) {
				const initializer = prop.getInitializer();
				if (initializer) {
					extraInitializers.push(`self.${propName} = ${transpileExpression(state, initializer)};\n`);
				}
			}
		}
	}

	node.getInstanceMethods()
		.filter(method => method.getBody() !== undefined)
		.forEach(method => {
			if (!hasIndexMembers) {
				hasIndexMembers = true;
				result += "\n";
			}
			result += transpileMethodDeclaration(state, method);
		});

	state.popIndent();

	if (hasInstanceInheritance) {
		result += `${hasIndexMembers ? state.indent : ""}}, super);\n`;
	} else {
		result += `${hasIndexMembers ? state.indent : ""}};\n`;
	}

	LUA_RESERVED_METAMETHODS.forEach(metamethod => {
		if (getClassMethod(node, metamethod)) {
			if (LUA_UNDEFINABLE_METAMETHODS.indexOf(metamethod) !== -1) {
				throw new TranspilerError(
					`Cannot use undefinable Lua metamethod as identifier '${metamethod}' for a class`,
					node,
					TranspilerErrorType.UndefinableMetamethod,
				);
			}
			result += state.indent + `${id}.${metamethod} = function(self, ...) return self:${metamethod}(...); end;\n`;
		}
	});

	if (!node.isAbstract()) {
		result += state.indent + `${id}.new = function(...)\n`;
		state.pushIndent();
		result += state.indent + `return ${id}.constructor(setmetatable({}, ${id}), ...);\n`;
		state.popIndent();
		result += state.indent + `end;\n`;
	}

	result += transpileConstructorDeclaration(
		state,
		id,
		getConstructor(node),
		extraInitializers,
		hasInstanceInheritance,
	);

	for (const prop of node.getStaticProperties()) {
		const propName = prop.getName();
		checkMethodReserved(propName, prop);

		let propValue = "nil";
		if (ts.TypeGuards.isInitializerExpressionableNode(prop)) {
			const initializer = prop.getInitializer();
			if (initializer) {
				propValue = transpileExpression(state, initializer);
			}
		}
		result += state.indent + `${id}.${propName} = ${propValue};\n`;
	}

	const getters = node
		.getInstanceProperties()
		.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isGetAccessorDeclaration(prop));
	let ancestorHasGetters = false;
	let ancestorClass: ts.ClassDeclaration | ts.ClassExpression | undefined = node;
	while (!ancestorHasGetters && ancestorClass !== undefined) {
		ancestorClass = ancestorClass.getBaseClass();
		if (ancestorClass !== undefined) {
			const ancestorGetters = ancestorClass
				.getInstanceProperties()
				.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isGetAccessorDeclaration(prop));
			if (ancestorGetters.length > 0) {
				ancestorHasGetters = true;
			}
		}
	}

	if (getters.length > 0 || ancestorHasGetters) {
		if (getters.length > 0) {
			let getterContent = "\n";
			state.pushIndent();
			for (const getter of getters) {
				getterContent += transpileAccessorDeclaration(state, getter, getter.getName());
			}
			state.popIndent();
			getterContent += state.indent;
			if (ancestorHasGetters) {
				result +=
					state.indent + `${id}._getters = setmetatable({${getterContent}}, { __index = super._getters });\n`;
			} else {
				result += state.indent + `${id}._getters = {${getterContent}};\n`;
			}
		} else {
			result += state.indent + `${id}._getters = super._getters;\n`;
		}
		result += state.indent + `local __index = ${id}.__index;\n`;
		result += state.indent + `${id}.__index = function(self, index)\n`;
		state.pushIndent();
		result += state.indent + `local getter = ${id}._getters[index];\n`;
		result += state.indent + `if getter then\n`;
		state.pushIndent();
		result += state.indent + `return getter(self);\n`;
		state.popIndent();
		result += state.indent + `else\n`;
		state.pushIndent();
		result += state.indent + `return __index[index];\n`;
		state.popIndent();
		result += state.indent + `end;\n`;
		state.popIndent();
		result += state.indent + `end;\n`;
	}

	const setters = node
		.getInstanceProperties()
		.filter((prop): prop is ts.SetAccessorDeclaration => ts.TypeGuards.isSetAccessorDeclaration(prop));
	let ancestorHasSetters = false;
	ancestorClass = node;
	while (!ancestorHasSetters && ancestorClass !== undefined) {
		ancestorClass = ancestorClass.getBaseClass();
		if (ancestorClass !== undefined) {
			const ancestorSetters = ancestorClass
				.getInstanceProperties()
				.filter((prop): prop is ts.GetAccessorDeclaration => ts.TypeGuards.isSetAccessorDeclaration(prop));
			if (ancestorSetters.length > 0) {
				ancestorHasSetters = true;
			}
		}
	}
	if (setters.length > 0 || ancestorHasSetters) {
		if (setters.length > 0) {
			let setterContent = "\n";
			state.pushIndent();
			for (const setter of setters) {
				setterContent += transpileAccessorDeclaration(state, setter, setter.getName());
			}
			state.popIndent();
			setterContent += state.indent;
			if (ancestorHasSetters) {
				result +=
					state.indent + `${id}._setters = setmetatable({${setterContent}}, { __index = super._setters });\n`;
			} else {
				result += state.indent + `${id}._setters = {${setterContent}};\n`;
			}
		} else {
			result += state.indent + `${id}._setters = super._setters;\n`;
		}
		result += state.indent + `${id}.__newindex = function(self, index, value)\n`;
		state.pushIndent();
		result += state.indent + `local setter = ${id}._setters[index];\n`;
		result += state.indent + `if setter then\n`;
		state.pushIndent();
		result += state.indent + `setter(self, value);\n`;
		state.popIndent();
		result += state.indent + `else\n`;
		state.pushIndent();
		result += state.indent + `rawset(self, index, value);\n`;
		state.popIndent();
		result += state.indent + `end;\n`;
		state.popIndent();
		result += state.indent + `end;\n`;
	}

	state.popIndent();
	if (isExpression) {
		result += state.indent + `end)()`;
	} else {
		result += state.indent + `end;\n`;
	}

	return result;
}

export function transpileClassDeclaration(state: TranspilerState, node: ts.ClassDeclaration) {
	return transpileClass(state, node);
}

export function transpileClassExpression(state: TranspilerState, node: ts.ClassExpression) {
	return transpileClass(state, node);
}
