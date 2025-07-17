import * as jsontokens from 'jsontokens';
import type { SignMessageType } from './wallet';

enum AddressPurposes {
  PAYMENT = 'payment',
  ORDINALS = 'ordinals',
}
export interface SignMessagePayload {
  address: string;
  message: string;
  protocol?: string;
}

export interface Account {
  address: string;
  publicKey: string;
  purpose: AddressPurposes;
}

interface MEBitcoinProviderInterface {
  connect(token: string): Promise<{ addresses: Account[] }>;

  signMessage(token: string): Promise<string>;
}

export class MEBitcoinProvider {
  private provider: MEBitcoinProviderInterface;

  private address?: string;

  private accounts: Account[] = [];
  constructor() {
    this.provider = (window as any).magicEden?.bitcoin;
    if (!this.provider) {
      throw new Error('Magic Eden Bitcoin provider not found');
    }
  }

  async connect() {
    const payload = {
      purposes: [AddressPurposes.PAYMENT],
    };
    const request = jsontokens.createUnsecuredToken(payload);

    const { addresses } = await this.provider.connect(request);
    return addresses.filter((a) => a.purpose === AddressPurposes.PAYMENT);
  }

  async requestAccounts() {
    this.accounts = await this.connect();
    const addresses = this.accounts.map((a) => a.address);

    if (addresses.length > 0) {
      this.address = addresses[0];
    }
    return addresses;
  }

  async signMessage(
    message: string,
    type?: string | SignMessageType,
    _address?: string,
  ): Promise<string> {
    const address = _address ?? this.address;

    if (!address) {
      throw new Error('address is required');
    }

    const payload: SignMessagePayload = {
      message,
      address,
      // as address is payment address, we can assume the protocol is ECDSA
      protocol: 'ECDSA',
    };
    // @ts-ignore
    const request = jsontokens.createUnsecuredToken(payload);

    const result = await this.provider.signMessage(request);

    return result;
  }

  async getNetwork() {
    return 'mainnet';
  }

  async getPublicKey() {
    return this.accounts[0]?.publicKey ?? '';
  }
}
