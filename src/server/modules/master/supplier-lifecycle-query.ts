import { z } from "zod";

/** Shared list/export filter contract. Pagination is deliberately outside export scope. */
export const supplierLifecycleFilterSchema = z.object({
  q: z.string().optional(),
  kind: z.enum(["", "admission", "corrective", "payment_term"]).optional(),
  status: z.enum(["", "open", "closed"]).optional(),
  supplierId: z.number().int().positive().safe().optional(),
  caseId: z.number().int().positive().safe().optional(),
  ownerId: z.number().int().positive().safe().optional(),
  sort: z.enum(["", "supplierCode", "priority", "dueDate", "ownerName", "createdAt"]).optional(),
  order: z.enum(["", "ascend", "descend"]).optional(),
}).strict();
export type SupplierLifecycleFilters = z.infer<typeof supplierLifecycleFilterSchema>;
export const supplierLifecycleListSchema = supplierLifecycleFilterSchema.extend({
  page: z.number().int().positive().safe().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
});
