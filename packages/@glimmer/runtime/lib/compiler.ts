import { Opaque, CompilationMeta } from '@glimmer/interfaces';
import Environment from './environment';
import { CompiledDynamicProgram, CompiledDynamicTemplate } from './compiled/blocks';
import { Maybe, Option } from '@glimmer/util';
import { Ops, TemplateMeta } from '@glimmer/wire-format';
import { Template } from './template';
import { Register, debugSlice } from './opcodes';
import { ATTRS_BLOCK, compileStatement } from './syntax/functions';
import * as ClientSide from './syntax/client-side';

import {
  ComponentArgs,
  ComponentBuilder as IComponentBuilder,
  DynamicComponentDefinition
} from './opcode-builder';

import { expr } from './syntax/functions';

import OpcodeBuilderDSL from './compiled/opcodes/builder';

import * as Component from './component/interfaces';

import * as WireFormat from '@glimmer/wire-format';

import { PublicVM } from './vm/append';
import { IArguments } from './vm/arguments';
import { FunctionExpression } from "./compiled/opcodes/expressions";

export interface CompilableLayout {
  compile(builder: Component.ComponentLayoutBuilder): void;
}

export function compileLayout(compilable: CompilableLayout, env: Environment): CompiledDynamicProgram {
  let builder = new ComponentLayoutBuilder(env);

  compilable.compile(builder);

  return builder.compile();
}

interface InnerLayoutBuilder {
  tag: Component.ComponentTagBuilder;
  attrs: Component.ComponentAttrsBuilder;
  compile(): CompiledDynamicProgram;
}

class ComponentLayoutBuilder implements Component.ComponentLayoutBuilder {
  private inner: InnerLayoutBuilder;

  constructor(public env: Environment) {}

  wrapLayout(layout: Template<TemplateMeta>) {
    this.inner = new WrappedBuilder(this.env, layout);
  }

  fromLayout(componentName: string, layout: Template<TemplateMeta>) {
    this.inner = new UnwrappedBuilder(this.env, componentName, layout);
  }

  compile(): CompiledDynamicProgram {
    return this.inner.compile();
  }

  get tag(): Component.ComponentTagBuilder {
    return this.inner.tag;
  }

  get attrs(): Component.ComponentAttrsBuilder {
    return this.inner.attrs;
  }
}

class WrappedBuilder implements InnerLayoutBuilder {
  public tag = new ComponentTagBuilder();
  public attrs = new ComponentAttrsBuilder();

  constructor(public env: Environment, private layout: Template<TemplateMeta>) {}

  compile(): CompiledDynamicProgram {
    //========DYNAMIC
    //        PutValue(TagExpr)
    //        Test
    //        JumpUnless(BODY)
    //        OpenDynamicPrimitiveElement
    //        DidCreateElement
    //        ...attr statements...
    //        FlushElement
    // BODY:  Noop
    //        ...body statements...
    //        PutValue(TagExpr)
    //        Test
    //        JumpUnless(END)
    //        CloseElement
    // END:   Noop
    //        DidRenderLayout
    //        Exit
    //
    //========STATIC
    //        OpenPrimitiveElementOpcode
    //        DidCreateElement
    //        ...attr statements...
    //        FlushElement
    //        ...body statements...
    //        CloseElement
    //        DidRenderLayout
    //        Exit

    let { env, layout } = this;
    let meta = { templateMeta: layout.meta, symbols: layout.symbols, asPartial: false };

    let dynamicTag = this.tag.getDynamic();
    let staticTag = this.tag.getStatic();

    let b = builder(env, meta);

    b.startLabels();

    if (dynamicTag) {
      b.fetch(Register.s1);

      expr(dynamicTag, b);

      b.dup();
      b.load(Register.s1);

      b.test('simple');

      b.jumpUnless('BODY');

      b.fetch(Register.s1);
      b.pushComponentOperations();
      b.openDynamicElement();
    } else if (staticTag) {
      b.pushComponentOperations();
      b.openElementWithOperations(staticTag);
    }

    if (dynamicTag || staticTag) {
      b.didCreateElement(Register.s0);

      let attrs = this.attrs.buffer;

      for (let i=0; i<attrs.length; i++) {
        compileStatement(attrs[i], b);
      }

      b.flushElement();
    }

    b.label('BODY');
    b.invokeStatic(layout.asBlock());

    if (dynamicTag) {
      b.fetch(Register.s1);
      b.test('simple');
      b.jumpUnless('END');
      b.closeElement();
    } else if (staticTag) {
      b.closeElement();
    }

    b.label('END');

    b.didRenderLayout(Register.s0);

    if (dynamicTag) {
      b.load(Register.s1);
    }

    b.stopLabels();

    let start = b.start;
    let end = b.finalize();

    debugSlice(env, start, end);

    return new CompiledDynamicTemplate(start, end, {
      meta,
      hasEval: layout.hasEval,
      symbols: layout.symbols.concat([ATTRS_BLOCK])
    });
  }
}

class UnwrappedBuilder implements InnerLayoutBuilder {
  public attrs = new ComponentAttrsBuilder();

  constructor(public env: Environment, private componentName: string, private layout: Template<TemplateMeta>) {}

  get tag(): Component.ComponentTagBuilder {
    throw new Error('BUG: Cannot call `tag` on an UnwrappedBuilder');
  }

  compile(): CompiledDynamicProgram {
    let { env, layout } = this;
    return layout.asLayout(this.componentName, this.attrs.buffer).compileDynamic(env);
  }
}

class ComponentTagBuilder implements Component.ComponentTagBuilder {
  public isDynamic: Option<boolean> = null;
  public isStatic: Option<boolean> = null;
  public staticTagName: Option<string> = null;
  public dynamicTagName: Option<WireFormat.Expression> = null;

  getDynamic(): Maybe<WireFormat.Expression> {
    if (this.isDynamic) {
      return this.dynamicTagName;
    }
  }

  getStatic(): Maybe<string> {
    if (this.isStatic) {
      return this.staticTagName;
    }
  }

  static(tagName: string) {
    this.isStatic = true;
    this.staticTagName = tagName;
  }

  dynamic(tagName: FunctionExpression<string>) {
    this.isDynamic = true;
    this.dynamicTagName = [Ops.ClientSideExpression, ClientSide.Ops.FunctionExpression, tagName];
  }
}

class ComponentAttrsBuilder implements Component.ComponentAttrsBuilder {
  public buffer: WireFormat.Statements.Attribute[] = [];

  static(name: string, value: string) {
    this.buffer.push([Ops.StaticAttr, name, value, null]);
  }

  dynamic(name: string, value: FunctionExpression<string>) {
    this.buffer.push([Ops.DynamicAttr, name, [Ops.ClientSideExpression, ClientSide.Ops.FunctionExpression, value], null]);
  }
}

export class ComponentBuilder implements IComponentBuilder {
  private env: Environment;

  constructor(private builder: OpcodeBuilderDSL) {
    this.env = builder.env;
  }

  static(definition: Component.ComponentDefinition<Opaque>, args: ComponentArgs) {
    let [params, hash, _default, inverse] = args;
    let { builder } = this;

    builder.pushComponentManager(definition);
    builder.invokeComponent(null, params, hash, _default, inverse);
  }

  dynamic(definitionArgs: ComponentArgs, getDefinition: DynamicComponentDefinition, args: ComponentArgs) {
    let [params, hash, block, inverse] = args;
    let { builder } = this;

    if (!definitionArgs || definitionArgs.length === 0) {
      throw new Error("Dynamic syntax without an argument");
    }

    let meta = this.builder.meta.templateMeta;

    function helper(vm: PublicVM, a: IArguments) {
      return getDefinition(vm, a, meta);
    }

    builder.startLabels();

    builder.pushFrame();

    builder.returnTo('END');

    builder.compileArgs(definitionArgs[0], definitionArgs[1], true);
    builder.helper(helper);

    builder.dup();
    builder.test('simple');

    builder.enter(2);

    builder.jumpUnless('ELSE');

    builder.pushDynamicComponentManager();
    builder.invokeComponent(null, params, hash, block, inverse);

    builder.label('ELSE');
    builder.exit();
    builder.return();

    builder.label('END');
    builder.popFrame();

    builder.stopLabels();
  }
}

export function builder(env: Environment, meta: CompilationMeta) {
  return new OpcodeBuilderDSL(env, meta);
}
