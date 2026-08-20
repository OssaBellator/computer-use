import type { StructuredEntityRef } from './documentModelIdentity.js';
export interface TextRange { start:number; end:number }
export interface TextSelection { selectionId:string; range:TextRange; direction:'forward'|'backward'|'none' }
export interface TextFormattingPatch { bold?:boolean;italic?:boolean;underline?:boolean;strike?:boolean;fontFamily?:string;fontSizePoints?:number;paragraphStyle?:string }
export interface TableRegion { table:StructuredEntityRef;startRow:number;endRow:number;startColumn:number;endColumn:number }
export interface CellAddress { row:number;column:number }
export interface CellRange { sheet:StructuredEntityRef;start:CellAddress;end:CellAddress }
export type SpreadsheetScalar = string|number|boolean|null;
export type SpreadsheetCellInput = {kind:'blank'}|{kind:'value';value:SpreadsheetScalar}|{kind:'formula';formula:string};
export interface SpreadsheetCellState { address:CellAddress;input:SpreadsheetCellInput;displayedValue?:string }
export const PRESENTATION_OBJECT_KINDS = ['text-box','shape','image','chart','table','media','group','other'] as const;
export type PresentationObjectKind = typeof PRESENTATION_OBJECT_KINDS[number];
export interface PresentationObjectRef extends StructuredEntityRef { kind:'presentation-object';objectKind:PresentationObjectKind;slideId:string }
export interface CodeBufferRef extends StructuredEntityRef { kind:'code-buffer';languageId?:string }
export interface CodeRange { buffer:CodeBufferRef;start:{line:number;column:number};end:{line:number;column:number} }
export type MediaEntityKind = 'media-timeline'|'media-track'|'media-clip';
export interface MediaEntityRef extends StructuredEntityRef { kind:MediaEntityKind }
export interface TimelineRange { timeline:MediaEntityRef;startSeconds:number;endSeconds:number }
export interface StructuredObjectRef extends StructuredEntityRef { kind:'structured-object';schemaKind?:string }
