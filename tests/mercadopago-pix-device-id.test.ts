import { describe, expect, test } from "vitest";
import {
  mercadoPagoDeviceIdSchema,
  MERCADO_PAGO_DEVICE_ID_MAX_LENGTH,
  normalizeMercadoPagoDeviceId,
} from "../src/lib/mercadopago-pix";

describe("Mercado Pago device ID", () => {
  test("accepts and preserves the maximum supported provider session ID", () => {
    const deviceId = `mp_${"a".repeat(MERCADO_PAGO_DEVICE_ID_MAX_LENGTH - 3)}`;

    expect(mercadoPagoDeviceIdSchema.parse(deviceId)).toBe(deviceId);
    expect(normalizeMercadoPagoDeviceId(deviceId)).toBe(deviceId);
  });

  test("rejects a provider session ID above the supported limit", () => {
    const deviceId = `mp_${"a".repeat(MERCADO_PAGO_DEVICE_ID_MAX_LENGTH - 2)}`;

    expect(mercadoPagoDeviceIdSchema.safeParse(deviceId).success).toBe(false);
    expect(normalizeMercadoPagoDeviceId(deviceId)).toBe("");
  });
});
