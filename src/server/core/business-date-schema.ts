import { z } from "zod";
import { shanghaiDay } from "./business-day";

/** Date-only business input, not a timestamp. Validate before a PostgreSQL date cast. */
export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD")
  .refine(value => !value.startsWith("0000") && shanghaiDay(value) === value, "日期不存在，请填写有效的日历日期");
