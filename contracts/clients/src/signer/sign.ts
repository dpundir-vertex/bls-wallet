import { signer } from "@thehubbleproject/bls";

import encodeMessageForSigning from "./encodeMessageForSigning";
import { Bundle, Operation } from "./types";

export default (
    signerFactory: signer.BlsSignerFactory,
    domain: Uint8Array,
    chainId: number,
    privateKey: string,
  ) =>
  (operation: Operation, walletAddress: string): Bundle => {
    const signer = signerFactory.getSigner(domain, privateKey);
    const message = encodeMessageForSigning(chainId)(operation, walletAddress);
    const signature = signer.sign(message);

    return {
      senderPublicKeys: [signer.pubkey],
      operations: [operation],
      signature,
    };
  };
