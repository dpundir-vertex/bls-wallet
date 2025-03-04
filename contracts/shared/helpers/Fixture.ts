import "@nomiclabs/hardhat-ethers";
import { ethers, network } from "hardhat";
import { Signer, Contract, BigNumber, BigNumberish, providers } from "ethers";

import {
  BlsWalletWrapper,
  BlsWalletSigner,
  initBlsWalletSigner,
  Bundle,
} from "../../clients/src";

import Range from "./Range";
import assert from "./assert";
import Create2Fixture from "./Create2Fixture";
import {
  AggregatorUtilities,
  BLSExpander,
  BLSOpen,
  // eslint-disable-next-line camelcase
  BLSWallet__factory,
  ProxyAdmin,
  VerificationGateway,
} from "../../typechain-types";

export default class Fixture {
  static readonly ECDSA_ACCOUNTS_LENGTH = 5;
  static readonly DEFAULT_BLS_ACCOUNTS_LENGTH = 5;

  private constructor(
    public chainId: number,
    public provider: providers.Provider,

    public signers: Signer[],
    public addresses: string[],

    public lazyBlsWallets: (() => Promise<BlsWalletWrapper>)[],

    public verificationGateway: VerificationGateway,

    public blsLibrary: BLSOpen,
    public blsExpander: BLSExpander,
    public utilities: AggregatorUtilities,

    // eslint-disable-next-line camelcase
    public BLSWallet: BLSWallet__factory,
    public blsWalletSigner: BlsWalletSigner,
  ) {}

  /// @dev Contracts deployed by first ethers signer
  static async create(
    blsWalletCount: number = Fixture.DEFAULT_BLS_ACCOUNTS_LENGTH,
    secretNumbers?: number[],
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const allSigners = await ethers.getSigners();
    const signers = allSigners.slice(0, Fixture.ECDSA_ACCOUNTS_LENGTH);
    const addresses = (await Promise.all(
      signers.map((acc) => acc.getAddress()),
    )) as string[];

    const create2Fixture = Create2Fixture.create();

    // deploy wallet implementation contract
    const blsWalletImpl = await create2Fixture.create2Contract("BLSWallet");
    const initializedEvents = await blsWalletImpl.queryFilter(
      blsWalletImpl.filters.Initialized(),
    );
    if (!initializedEvents.length) {
      await blsWalletImpl.initialize(ethers.constants.AddressZero);
    }

    const bls = (await create2Fixture.create2Contract("BLSOpen")) as BLSOpen;
    const ProxyAdmin = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = (await ProxyAdmin.deploy()) as ProxyAdmin;
    await proxyAdmin.deployed();
    // deploy Verification Gateway
    const verificationGateway = (await create2Fixture.create2Contract(
      "VerificationGateway",
      ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "address"],
        [bls.address, blsWalletImpl.address, proxyAdmin.address],
      ),
    )) as VerificationGateway;
    await (
      await proxyAdmin.transferOwnership(verificationGateway.address)
    ).wait();

    // deploy BLSExpander Gateway
    const blsExpander = (await create2Fixture.create2Contract(
      "BLSExpander",
      ethers.utils.defaultAbiCoder.encode(
        ["address"],
        [verificationGateway.address],
      ),
    )) as BLSExpander;

    // deploy utilities
    const utilities = (await create2Fixture.create2Contract(
      "AggregatorUtilities",
    )) as AggregatorUtilities;

    const BLSWallet = await ethers.getContractFactory("BLSWallet");

    const lazyBlsWallets = Range(blsWalletCount).map((i) => {
      let secretNumber: number;

      if (secretNumbers !== undefined) {
        secretNumber = secretNumbers[i];
        assert(!isNaN(secretNumber), "secret ");
      } else {
        secretNumber = Math.abs((Math.random() * 0xffffffff) << 0);
      }

      return async () => {
        const wallet = await BlsWalletWrapper.connect(
          `0x${secretNumber.toString(16)}`,
          verificationGateway.address,
          verificationGateway.provider,
        );

        // Perform an empty transaction to trigger wallet creation
        await (
          await verificationGateway.processBundle(
            wallet.sign({
              nonce: BigNumber.from(0),
              actions: [],
            }),
          )
        ).wait();

        return wallet;
      };
    });

    const privateKey = await BlsWalletWrapper.getRandomBlsPrivateKey();

    return new Fixture(
      chainId,
      ethers.provider,
      signers,
      addresses,
      lazyBlsWallets,
      verificationGateway,
      bls,
      blsExpander,
      utilities,
      BLSWallet,
      await initBlsWalletSigner({ chainId, privateKey }),
    );
  }

  /**
   * Creates new BLS contract wallets from private keys
   * @returns array of wallets
   */
  async createBLSWallets(): Promise<BlsWalletWrapper[]> {
    return this.lazyBlsWallets.reduce(async (prev, lazyWallet) => {
      const wallets = await prev;
      return [...wallets, await lazyWallet()];
    }, Promise.resolve([]));
  }

  bundleFrom(
    wallet: BlsWalletWrapper,
    contract: Contract,
    method: string,
    params: any[],
    nonce: BigNumberish,
    ethValue: BigNumberish = 0,
  ): Bundle {
    return this.blsWalletSigner.aggregate([
      wallet.sign({
        nonce,
        actions: [
          {
            ethValue,
            contractAddress: contract.address,
            encodedFunction: contract.interface.encodeFunctionData(
              method,
              params,
            ),
          },
        ],
      }),
    ]);
  }

  async call(
    wallet: BlsWalletWrapper,
    contract: Contract,
    method: string,
    params: any[],
    nonce: BigNumberish,
    ethValue: BigNumberish = 0,
  ) {
    await (
      await this.verificationGateway.processBundle(
        this.bundleFrom(wallet, contract, method, params, nonce, ethValue),
      )
    ).wait();
  }

  async callStatic(
    wallet: BlsWalletWrapper,
    contract: Contract,
    method: string,
    params: any[],
    nonce: BigNumberish,
    ethValue: BigNumberish = 0,
  ) {
    return await this.verificationGateway.callStatic.processBundle(
      this.bundleFrom(wallet, contract, method, params, nonce, ethValue),
    );
  }

  async advanceTimeBy(seconds: number) {
    // Advance time one week
    const latestTimestamp = (await ethers.provider.getBlock("latest"))
      .timestamp;

    await network.provider.send("evm_setNextBlockTimestamp", [
      BigNumber.from(latestTimestamp).add(seconds).toHexString(),
    ]);

    const wallet = await this.lazyBlsWallets[1]();

    // Process an empty operation so that the next timestamp above actually gets
    // into a block. This enables static calls to see the updated time.
    await (
      await this.verificationGateway.processBundle(
        wallet.sign({
          nonce: await wallet.Nonce(),
          actions: [],
        }),
      )
    ).wait();
  }
}
