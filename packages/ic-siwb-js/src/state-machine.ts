import type { ActorSubclass } from '@dfinity/agent';
import {
  type DelegationChain,
  DelegationIdentity,
  Ed25519KeyIdentity,
} from '@dfinity/identity';
import { assign, emit, fromPromise, setup } from 'xstate';

import type {
  _SERVICE as SIWB_IDENTITY_SERVICE,
  SignMessageType as SignMessageRawType,
} from './declarations/ic_siwb_provider.did';
import { createDelegationChain } from './delegation';
import {
  callGetDelegation,
  callLogin,
  callPrepareLogin,
} from './siwb-provider';
import { SiwbStorage } from './storage';
import {
  AddressType,
  getAddressType,
  getRegisterExtension,
  type NetworkItem,
  type SupportedProvider,
  type WalletProviderKey,
} from './wallet';

export type State =
  | 'initializing'
  | 'connecting'
  | 'disconnected'
  | 'connected'
  | 'preparing'
  | 'signing'
  | 'authenticating'
  | 'authenticated'
  | 'idle';

export type Context = {
  providerKey?: WalletProviderKey;
  address?: string;
  publicKey?: string;
  connected: boolean;
  provider?: SupportedProvider;
  network?: NetworkItem;
  anonymousActor?: ActorSubclass<SIWB_IDENTITY_SERVICE>;
  identity?: DelegationIdentity;
  delegationChain?: DelegationChain;
  siwbMessage?: string;
  signMessageType?: SignMessageRawType;
  signature?: string;
};

export type ConnectEvent = { type: 'CONNECT'; providerKey: WalletProviderKey };
export type SignEvent = { type: 'SIGN' };
export type Dispatch = ConnectEvent | SignEvent;

export type ConnectingEvent = {
  type: 'CONNECTING';
  data: { providerKey: WalletProviderKey };
};
export type ConnectedEvent = {
  type: 'CONNECTED';
  data: {
    address: string;
    addresses: string[];
    provider: SupportedProvider;
    providerKey: WalletProviderKey;
    network: NetworkItem;
  };
};
export type DisconnectedEvent = { type: 'DISCONNECTED' };
export type SigningEvent = { type: 'SIGNING'; data: string };
export type SignDataPreparedEvent = {
  type: 'SIGN_DATA_PREPARED';
  data: string;
};
export type SingatureSettledEvent = {
  type: 'SIGNATURE_SETTLED';
  data: {
    signature: string;
    publicKey: string;
    signMessageType: SignMessageRawType;
  };
};
export type ErrorEvent<T = unknown> = {
  type: 'ERROR';
  data: T;
};
export type AuthenticatedEvent = {
  type: 'AUTHENTICATED';
  data: DelegationIdentity;
};
export type RootEvent =
  // | ConnectingEvent
  | ConnectedEvent
  | DisconnectedEvent
  | SignDataPreparedEvent
  // | SigningEvent
  | SingatureSettledEvent
  | AuthenticatedEvent
  | ErrorEvent;

const init = fromPromise(async () => {
  return { connected: false };
});

const connect = fromPromise<
  ConnectedEvent['data'],
  { providerKey: WalletProviderKey },
  ConnectingEvent
>(async ({ input: { providerKey }, emit }) => {
  emit({ type: 'CONNECTING', data: { providerKey } });
  const { provider, address, network, addresses } =
    await getRegisterExtension(providerKey);
  if (!provider) {
    throw new Error('Provider not found');
  }
  if (!address || !network) {
    throw new Error('Address or network not found');
  }

  return { address, addresses, network, provider, providerKey };
});

const prepare = fromPromise<
  string,
  { actor: ActorSubclass<SIWB_IDENTITY_SERVICE>; address: string }
>(async ({ input: { actor, address } }) => {
  const siwbMessage = await callPrepareLogin(actor, address);

  return siwbMessage;
});

export interface SignMessageParams {
  selectedProviderKey: WalletProviderKey;
  provider: SupportedProvider;
  address: string;
  siwbMessage: string;
}

const signMessage = fromPromise<
  SingatureSettledEvent['data'],
  SignMessageParams,
  SigningEvent
>(
  async ({
    input: { siwbMessage, provider, address, selectedProviderKey },
    emit,
  }) => {
    emit({ type: 'SIGNING', data: siwbMessage });
    let signMessageType;
    if (
      selectedProviderKey === 'BitcoinProvider' ||
      selectedProviderKey === 'XverseProviders.BitcoinProvider' ||
      selectedProviderKey === 'OrangecryptoProviders.BitcoinProvider'
    ) {
      const [addressType] = getAddressType(address);
      if (
        addressType === AddressType.P2TR ||
        addressType === AddressType.P2WPKH
      ) {
        signMessageType = { Bip322Simple: null };
      } else {
        signMessageType = { ECDSA: null };
      }
    } else {
      signMessageType = { ECDSA: null };
    }

    const signature = await provider.signMessage(siwbMessage as string);
    const publicKey = await provider.getPublicKey();

    return { signature, publicKey, signMessageType };
  },
);

const authenticate = fromPromise<
  DelegationIdentity,
  SingatureSettledEvent['data'] & {
    actor: ActorSubclass<SIWB_IDENTITY_SERVICE>;
    address: string;
  }
>(
  async ({
    input: { actor, publicKey, address, signMessageType, signature },
  }) => {
    // Important for security! A random session identity is created on each authenticate.
    const sessionIdentity = Ed25519KeyIdentity.generate();

    const sessionPublicKey = sessionIdentity.getPublicKey().toDer();

    // Logging in is a two-step process. First, the signed SIWB message is sent to the backend.
    // Then, the backend's siwb_get_delegation method is called to get the delegation.
    const loginOkResponse = await callLogin(
      actor,
      signature,
      address,
      publicKey,
      sessionPublicKey,
      signMessageType,
    );
    // Call the backend's siwb_get_delegation method to get the delegation.
    const signedDelegation = await callGetDelegation(
      actor,
      address,
      sessionPublicKey,
      loginOkResponse.expiration,
    );

    // Create a new delegation chain from the delegation.
    const delegationChain = createDelegationChain(
      signedDelegation,
      loginOkResponse.user_canister_pubkey,
    );

    // Create a new delegation identity from the session identity and the
    // delegation chain.
    const identity = DelegationIdentity.fromDelegation(
      sessionIdentity,
      delegationChain,
    );

    // Save the identity to idb storage.
    await SiwbStorage.save(sessionIdentity, delegationChain, address);

    return identity;
  },
);

export const siwbMachine = setup({
  types: {
    context: {} as Context,
    events: {} as Dispatch,
    emitted: {} as RootEvent,
    input: {} as Pick<Context, 'anonymousActor'>,
  },
  actors: {
    init,
    connect,
    prepare,
    signMessage,
    authenticate,
  },
  guards: {
    isConnected: ({ context }) => context.connected,
  },
}).createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5SwJYHcBGBZAhgYwAsUA7MAOhJQBcUcAbFALxKgGIIB7Ui4gNw4DW5VJlyES5SjXpMWCEvzw4aXANoAGALobNiUAAcOqFcT0gAHogBs69WQCcj+1YCMAdntuAHACYAzACsADQgAJ6IPgAsXmQ+AbYukfFWVn5+6j4AvpkhItj4RNxStAzMxGxgAE6VHJVk+nTKAGa1ALZkeWKFksTUJbLl8nwcSiY6OmaGxihcZpYINnZOzu6evoEh4Qg+tmRu8bYBgW5WXpFu2bno+eLceFykeDTl7Fw9-EId110SZPfEj2eUCGimUM2I4y0kyMfVmSAs1j8PjI7hcZz8Z0iVk8Vk2iD8Jz2BxcGLSLh82MuIE6BV+-0BLFYVRqdQazTaX1EtLuDzATzkChGYLUWgm8KmsNM8PmazI6j85MiiS88XJwTC+LisQO6ki0QCRyOVJpt3I+kqYH0OEqjM4RWGnxN3XqFqtNsGgtG4MhunFMJMcwiFNi8pJ6nsaVsvnVWysPhcZC8aUC5JS6jcLgCxu+3LNrutjOZtXqjSoLUq7Sdv3NloLHuGXpF2ihfumcNA8x8wZ2CvSEfS6mjeIQXgTOts3iRLnUAQuOWpOdNXygvRedvegmEi+dqBXAobwohopbBn94MDC12y1cHm8-hjiDchKTaSTLlRRxc2a5S93q4q1TFmyZYclW3B-vuoJjMevqnm2UodtYV5ODeaz3sOcaRGQyYphSNgZlm85geQdAcFAUC2m8PAfFuP7OqR5GQUK0HNrBIASgG0qILKoZRMqqpxMOHgJoOaRWJE9hePYEmRFkRHbr8DEUS8RasqW5aVgp3BKUxjZHqx0LwRePEKnx+rqGqQmRH4ZABC+BpnDOSReN+NzOigEB0GArAAMIAPIAHIBQAoj5AAqYpwZKF7Tuc2E+KOfipOJcQBJEw4Esi+wJElfh6kmc5XHRvweV5rAAMoAJIAOIBZF7Fnu2CIICZir8RZgkagg8TIqJeVxtJCpflSxAcBAcBmMRhnRVxCAALS4l1C1yrYq1ratiSuT89p9DIZRQNNnGIQgeoBIm1luLqZxWPspwPts4a2atOyyaOLgRpEW25n8vL8uUh3nrNwm2RGBHTv40QuBlSXYcmRyDh4WJWF9S41m6LAA018yyRlATInEE4+B4M5PvsKM7ige7-a2M3HaS2H2OoqR5UTSWZulXUBJ4sORnl3gI345OKWRykHTTR3NV4M4ogEcY7MT7g411+zIsmery1i8r2EL2ki5AmMIc15KBE9q2XQqVizotWzE3KL5RCcJLkoVC7FUUnlgAbMX3qbE6hpbJxCUTtk7F4+xKhSCWEdkQA */
  id: 'siwbMachine',
  context: ({ input }) => ({
    ...input,
    connected: false,
  }),
  initial: 'initializing',
  states: {
    initializing: {
      id: 'initializing',
      invoke: {
        src: 'init',
        onDone: {
          target: 'idle',
          actions: [
            assign(({ event: { output } }) => ({
              connected: output.connected,
            })),
          ],
        },
        onError: 'idle',
      },
    },
    connecting: {
      id: 'connecting',
      invoke: {
        src: 'connect',
        input: ({ context, event }) => ({
          providerKey:
            (event as ConnectEvent)?.providerKey ?? context.providerKey,
        }),
        onDone: {
          target: 'preparing',
          actions: [
            assign(({ event: { output } }) => ({
              address: output.address,
              connected: true,
              provider: output.provider,
              providerKey: output.providerKey,
              network: output.network,
            })),
            emit(({ event: { output } }) => ({
              type: 'CONNECTED',
              data: output,
            })),
          ],
        },
        onError: {
          target: 'idle',
          actions: [
            emit(({ event: { error } }) => ({
              type: 'ERROR',
              data: error,
            })),
          ],
        },
      },
    },
    preparing: {
      id: 'preparing',
      invoke: {
        src: 'prepare',
        input: ({ context }) => ({
          actor: context.anonymousActor!,
          address: context.address!,
        }),
        onDone: {
          target: 'signing',
          actions: [
            assign(({ event: { output } }) => ({ siwbMessage: output })),
            emit(({ event: { output } }) => ({
              type: 'SIGN_DATA_PREPARED',
              data: output,
            })),
          ],
        },
        onError: {
          target: 'idle',
          actions: [
            emit(({ event: { error } }) => ({
              type: 'ERROR',
              data: error,
            })),
          ],
        },
      },
    },
    signing: {
      id: 'signing',
      invoke: {
        src: 'signMessage',
        input: ({ context }) => ({
          siwbMessage: context.siwbMessage!,
          provider: context.provider!,
          address: context.address!,
          selectedProviderKey: context.providerKey!,
        }),
        onDone: {
          target: 'authenticating',
          actions: [
            emit(({ event: { output } }) => ({
              type: 'SIGNATURE_SETTLED',
              data: output,
            })),
            assign(({ event: { output } }) => ({
              publicKey: output.publicKey,
              signature: output.signature,
              signMessageType: output.signMessageType,
            })),
          ],
        },
        onError: {
          target: 'idle',
          actions: [
            emit(({ event: { error } }) => ({
              type: 'ERROR',
              data: error,
            })),
          ],
        },
      },
    },
    authenticating: {
      id: 'authenticating',
      invoke: {
        src: 'authenticate',
        input: ({ context }) => ({
          actor: context.anonymousActor!,
          publicKey: context.publicKey!,
          address: context.address!,
          signature: context.signature!,
          signMessageType: context.signMessageType!,
        }),
        onDone: {
          target: 'authenticated',
          actions: [
            assign(({ event: { output } }) => ({
              identity: output,
            })),
            emit(({ event: { output } }) => ({
              type: 'AUTHENTICATED',
              data: output,
            })),
          ],
        },
        onError: {
          target: 'idle',
          actions: [
            emit(({ event: { error } }) => ({
              type: 'ERROR',
              data: error,
            })),
          ],
        },
      },
    },
    authenticated: {
      id: 'authenticated',
      on: {
        CONNECT: 'connecting',
        SIGN: { target: 'signing', guard: 'isConnected' },
      },
    },
    idle: {
      id: 'idle',
      on: {
        CONNECT: 'connecting',
        SIGN: { target: 'signing', guard: 'isConnected' },
      },
    },
  },
});
