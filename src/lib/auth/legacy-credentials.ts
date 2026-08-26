import "server-only";

export type PasswordVerifier = {
  salt: string;
  passwordHash: string;
};

export const LEGACY_PASSWORD_VERIFIERS: Readonly<Record<string, PasswordVerifier>> = {
  jerry: { salt: "u6ZRfR-mSgxr4jE8rIgG0g", passwordHash: "8KL4JTzjMs3H7-ohzSINJmVTsv9GUmPNRw3d-he2SQE" },
  jiaqi: { salt: "UABndEoYw_a6x478-F1kGQ", passwordHash: "IgkoGnIV8cwon2Ku7pSwisUb-puG7XDnuLXYkX0olzU" },
  wendy: { salt: "r3bn02cgBdgnQArpYHCjQg", passwordHash: "YtvgZDTBA1FOVgqfEIfyoaX9nerWc7AeRYJ05Uas4iA" },
  kevin: { salt: "b2NnVZYS4nobKNj9rgJaQA", passwordHash: "AkenQ3xSpuCoMawcfBrqICSei7p2RMvBgzdtBR8tVDo" },
  daniel: { salt: "s88y0DC3Ogk_EA0zkDyf5A", passwordHash: "FZ4-TRKvHQW_KXYlh9s3bM9vDzPybhVjPfdEJfp2bS8" },
  sam: { salt: "ojR3tLtbnBHl8PQotDZL5w", passwordHash: "jAOEkSMaVhHwTntp0rsc7NsvYWDZYaS8pV9mpq2d7D0" },
  ruihan: { salt: "eElq7KgqFzN-JESkw1DDDg", passwordHash: "6qmZxA_8iJRb6m6W5Y2CxrvsrBhHtY2VPePqH3fqvaY" },
  hogan: { salt: "p_ZBcrZWF0yiciHRoyW4rQ", passwordHash: "srIqjv2ofGOlUZ1UkDPwpTw2fIz4DSFUESTVzCM2oL0" },
};

export const DUMMY_PASSWORD_VERIFIER = LEGACY_PASSWORD_VERIFIERS.jerry;
