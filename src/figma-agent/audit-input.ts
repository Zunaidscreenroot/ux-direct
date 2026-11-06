import { z } from "zod";
import { RENDERED_IMAGE_MAX_CHARS } from "@/src/providers/active-chat-provider";

/** Same cap as the improve flow: the plugin sends captureRenderedNodePreview() JPEGs (~1400px side). */
export const auditImageSchema = z.string().max(RENDERED_IMAGE_MAX_CHARS).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
