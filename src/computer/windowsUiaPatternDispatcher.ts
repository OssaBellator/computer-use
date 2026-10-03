import type { DesktopBackendActionResult } from './desktopUiBackend.js';
import type { WindowsUiaNativeElementHandle } from './windowsUiaProviderRuntime.js';
import type { WindowsUiaSemanticAction } from './windowsUiaContract.js';

export type WindowsUiaNativePatternResult =
  | { readonly status:'invoked'; readonly evidence?:readonly string[] }
  | { readonly status:'unsupported'; readonly evidence?:readonly string[] }
  | { readonly status:'rejected'; readonly evidence?:readonly string[] };

export interface WindowsUiaNativePatternInvoker {
  invoke(element:WindowsUiaNativeElementHandle):Promise<WindowsUiaNativePatternResult>;
  setValue(element:WindowsUiaNativeElementHandle,value:string):Promise<WindowsUiaNativePatternResult>;
  toggle(element:WindowsUiaNativeElementHandle):Promise<WindowsUiaNativePatternResult>;
  select(element:WindowsUiaNativeElementHandle):Promise<WindowsUiaNativePatternResult>;
  setExpandCollapseState(element:WindowsUiaNativeElementHandle,state:'expanded'|'collapsed'):Promise<WindowsUiaNativePatternResult>;
  scroll(
    element:WindowsUiaNativeElementHandle,
    horizontal:'large-decrement'|'small-decrement'|'no-amount'|'large-increment'|'small-increment',
    vertical:'large-decrement'|'small-decrement'|'no-amount'|'large-increment'|'small-increment',
  ):Promise<WindowsUiaNativePatternResult>;
  setRangeValue(element:WindowsUiaNativeElementHandle,value:number):Promise<WindowsUiaNativePatternResult>;
  setWindowVisualState(element:WindowsUiaNativeElementHandle,state:'minimized'|'maximized'|'normal'):Promise<WindowsUiaNativePatternResult>;
  closeWindow(element:WindowsUiaNativeElementHandle):Promise<WindowsUiaNativePatternResult>;
}

function map(result:WindowsUiaNativePatternResult):DesktopBackendActionResult {
  if (result.status === 'invoked') {
    return {
      status:'completed',
      dispatched:true,
      ...(result.evidence ? {evidence:Object.freeze([...result.evidence])} : {}),
    };
  }
  return {
    status:result.status,
    dispatched:false,
    verified:false,
    ...(result.evidence ? {evidence:Object.freeze([...result.evidence])} : {}),
  };
}

/**
 * Maps the neutral semantic action union to one UIA control-pattern call.
 *
 * Implementations must report `unsupported` before crossing an action call
 * boundary when GetCurrentPattern/QueryInterface cannot obtain the required
 * pattern. Once the native method is entered, exceptions propagate so the
 * outer semantic runtime records sticky UNKNOWN rather than retrying.
 */
export async function dispatchWindowsUiaPattern(
  invoker:WindowsUiaNativePatternInvoker,
  element:WindowsUiaNativeElementHandle,
  action:WindowsUiaSemanticAction,
):Promise<DesktopBackendActionResult> {
  switch (action.kind) {
    case 'invoke':
      return map(await invoker.invoke(element));
    case 'set-value':
      return map(await invoker.setValue(element,action.value));
    case 'toggle':
      return map(await invoker.toggle(element));
    case 'select':
      return map(await invoker.select(element));
    case 'expand-collapse':
      return map(await invoker.setExpandCollapseState(element,action.state));
    case 'scroll':
      return map(await invoker.scroll(element,action.horizontal,action.vertical));
    case 'set-range-value':
      return map(await invoker.setRangeValue(element,action.value));
    case 'window':
      if (action.operation === 'close') return map(await invoker.closeWindow(element));
      return map(await invoker.setWindowVisualState(
        element,
        action.operation === 'minimize' ? 'minimized' : action.operation === 'maximize' ? 'maximized' : 'normal',
      ));
  }
}
