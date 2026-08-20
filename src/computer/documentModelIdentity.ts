export const DOCUMENT_KINDS = ['word-processing','spreadsheet','presentation','code-workspace','media-project','structured-project'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];
export interface DocumentRef { documentId:string; generation:number; kind:DocumentKind }
export const DOCUMENT_REPLACEMENT_REASONS = ['reload','reopen','replace','import','recover'] as const;
export type DocumentReplacementReason = typeof DOCUMENT_REPLACEMENT_REASONS[number];
export interface DocumentReplacement { previous:DocumentRef; current:DocumentRef; reason:DocumentReplacementReason }
export const STRUCTURED_ENTITY_KINDS = ['section','page','slide','sheet','table','presentation-object','code-buffer','media-timeline','media-track','media-clip','structured-object'] as const;
export type StructuredEntityKind = typeof STRUCTURED_ENTITY_KINDS[number];
export interface StructuredEntityRef { document:DocumentRef; kind:StructuredEntityKind; entityId:string; generation:number; parentEntityId?:string }
export interface DocumentIdentityState { document:DocumentRef; entities:readonly {kind:StructuredEntityKind;entityId:string;generation:number}[] }
export type FreshnessFailure = 'document-identity-mismatch'|'document-generation-stale'|'document-kind-mismatch'|'entity-missing'|'entity-kind-mismatch'|'entity-generation-stale';
export type FreshnessResult = {fresh:true}|{fresh:false;reason:FreshnessFailure};
export const MAX_OPAQUE_ID_BYTES = 256;
export function utf8Bytes(value:string):number { return new TextEncoder().encode(value).byteLength }
export function validOpaqueId(value:string):boolean { return value.length>0&&utf8Bytes(value)<=MAX_OPAQUE_ID_BYTES&&!/[\r\n\0]/.test(value) }
export function validGeneration(value:number):boolean { return Number.isSafeInteger(value)&&value>=0 }
export function sameDocumentRef(a:DocumentRef,b:DocumentRef):boolean { return a.documentId===b.documentId&&a.generation===b.generation&&a.kind===b.kind }
export function sameStructuredEntityRef(a:StructuredEntityRef,b:StructuredEntityRef):boolean { return sameDocumentRef(a.document,b.document)&&a.kind===b.kind&&a.entityId===b.entityId&&a.generation===b.generation }
export function validateDocumentRef(ref:DocumentRef):readonly string[] {
 const e:string[]=[]; if(!validOpaqueId(ref.documentId))e.push('documentId must be a bounded opaque identifier'); if(!validGeneration(ref.generation))e.push('document generation must be a non-negative safe integer'); if(!DOCUMENT_KINDS.includes(ref.kind))e.push('document kind is unsupported'); return e;
}
export function validateStructuredEntityRef(ref:StructuredEntityRef):readonly string[] {
 const e=[...validateDocumentRef(ref.document)]; if(!STRUCTURED_ENTITY_KINDS.includes(ref.kind))e.push('entity kind is unsupported'); if(!validOpaqueId(ref.entityId))e.push('entityId must be a bounded opaque identifier'); if(!validGeneration(ref.generation))e.push('entity generation must be a non-negative safe integer'); if(ref.parentEntityId!==undefined&&!validOpaqueId(ref.parentEntityId))e.push('parentEntityId must be a bounded opaque identifier'); return e;
}
export function checkDocumentFreshness(reference:DocumentRef,current:DocumentRef):FreshnessResult {
 if(reference.documentId!==current.documentId)return {fresh:false,reason:'document-identity-mismatch'}; if(reference.kind!==current.kind)return {fresh:false,reason:'document-kind-mismatch'}; if(reference.generation!==current.generation)return {fresh:false,reason:'document-generation-stale'}; return {fresh:true};
}
export function checkEntityFreshness(reference:StructuredEntityRef,current:DocumentIdentityState):FreshnessResult {
 const d=checkDocumentFreshness(reference.document,current.document); if(!d.fresh)return d; const x=current.entities.find(v=>v.entityId===reference.entityId); if(!x)return {fresh:false,reason:'entity-missing'}; if(x.kind!==reference.kind)return {fresh:false,reason:'entity-kind-mismatch'}; if(x.generation!==reference.generation)return {fresh:false,reason:'entity-generation-stale'}; return {fresh:true};
}
export function describeReplacement(previous:DocumentRef,current:DocumentRef,reason:DocumentReplacementReason):DocumentReplacement {
 if(previous.documentId!==current.documentId)throw new Error('replacement must preserve documentId; use a distinct DocumentRef for a different document'); if(previous.kind!==current.kind)throw new Error('replacement cannot change document kind'); if(current.generation<=previous.generation)throw new Error('replacement must advance document generation'); return {previous,current,reason};
}
