/** Read-only JG material evidence. No quantity here grants stock reservation or approval. */
export interface JgMaterialLine {
  materialSkuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  grossReq: string;
  issuedQty: string;
  returnedQty: string;
  draftIssueQty: string;
  pendingIssueQty: string;
  draftReturnQty: string;
  pendingReturnQty: string;
  /** Whole-WO issue allowance, including sibling JGs; legacy fields above remain this JG. */
  woIssuedQty: string;
  woDraftIssueQty: string;
  woPendingIssueQty: string;
  suggestedIssueQty: string;
}

export interface JgMaterialBasis {
  jgId: number;
  woId: number;
  supplierId: number;
  observedAt: string;
  lines: JgMaterialLine[];
  openDocuments: { kind: "fl" | "tl"; id: number; docNo: string; status: "draft" | "pending" }[];
  woOpenIssues: { kind: "fl"; id: number; docNo: string; status: "draft" | "pending"; jgId: number; jgDocNo: string }[];
}
