import * as protobufs from '@farcaster/protobufs';
import { bytesToUtf8String, hexStringToBytes, HubAsyncResult, HubError, toFarcasterTime } from '@farcaster/utils';
import { BigNumber, Contract, Event, providers } from 'ethers';
import { err, ok, Result, ResultAsync } from 'neverthrow';
import { IdRegistry, NameRegistry } from '~/eth/abis';
import { bytes32ToBytes, bytesToBytes32 } from '~/eth/utils';
import { HubInterface } from '~/hubble';
import { logger } from '~/utils/logger';

const log = logger.child({
  component: 'EthEventsProvider',
});

export class GoerliEthConstants {
  public static IdRegistryAddress = '0xda107a1caf36d198b12c16c7b6a1d1c795978c42';
  public static NameRegistryAddress = '0xe3be01d99baa8db9905b33a3ca391238234b79d1';
  public static FirstBlock = 7648795;
  public static ChunkSize = 10000;
}

type NameRegistryRenewEvent = Omit<protobufs.NameRegistryEvent, 'to' | 'from'>;

/**
 * Class that follows the Ethereum chain to handle on-chain events from the ID Registry and Name Registry contracts.
 */
export class EthEventsProvider {
  private _hub: HubInterface;
  private _jsonRpcProvider: providers.BaseProvider;

  private _idRegistryContract: Contract;
  private _nameRegistryContract: Contract;

  private _numConfirmations: number;

  private _idEventsByBlock: Map<number, Array<protobufs.IdRegistryEvent>>;
  private _nameEventsByBlock: Map<number, Array<protobufs.NameRegistryEvent>>;
  private _renewEventsByBlock: Map<number, Array<NameRegistryRenewEvent>>;

  private _lastBlockNumber: number;

  // Whether the historical events have been synced. This is used to avoid syncing the events multiple times.
  private _isHistoricalSyncDone = false;

  constructor(
    hub: HubInterface,
    jsonRpcProvider: providers.BaseProvider,
    idRegistryContract: Contract,
    nameRegistryContract: Contract
  ) {
    this._hub = hub;
    this._jsonRpcProvider = jsonRpcProvider;
    this._idRegistryContract = idRegistryContract;
    this._nameRegistryContract = nameRegistryContract;

    // Number of blocks to wait before processing an event.
    // This is hardcoded to 6 for now, because that's the threshold beyond which blocks are unlikely to reorg anymore.
    // 6 blocks represents ~72 seconds on Goerli, so the delay is not too long.
    this._numConfirmations = 6;

    this._lastBlockNumber = 0;

    // Initialize the cache for the ID and Name Registry events. They will be processed after
    // numConfirmations blocks have been mined.
    this._nameEventsByBlock = new Map();
    this._idEventsByBlock = new Map();
    this._renewEventsByBlock = new Map();

    // Setup IdRegistry contract
    this._idRegistryContract.on('Register', (to: string, id: BigNumber, _recovery, _url, event: Event) => {
      this.cacheIdRegistryEvent(null, to, id, protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER, event);
    });
    this._idRegistryContract.on('Transfer', (from: string, to: string, id: BigNumber, event: Event) => {
      this.cacheIdRegistryEvent(from, to, id, protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_TRANSFER, event);
    });

    // Setup NameRegistry contract
    this._nameRegistryContract.on('Transfer', (from: string, to: string, tokenId: BigNumber, event: Event) => {
      this.cacheNameRegistryEvent(from, to, tokenId, event);
    });

    this._nameRegistryContract.on('Renew', (tokenId: BigNumber, expiry: BigNumber, event: Event) => {
      this.cacheRenewEvent(tokenId, expiry, event);
    });

    // Set up block listener to confirm blocks
    this._jsonRpcProvider.on('block', (blockNumber: number) => this.handleNewBlock(blockNumber));
  }

  /**
   *
   * Setup a Eth Events Provider with Goerli testnet, which is currently used for Production Farcaster Hubs.
   */
  public static makeWithGoerli(
    hub: HubInterface,
    ethRpcUrl: string,
    IdRegistryAddress: string,
    NameRegistryAddress: string
  ): EthEventsProvider {
    // Setup provider and the contracts
    const jsonRpcProvider = new providers.JsonRpcProvider(ethRpcUrl);

    const idRegistryContract = new Contract(IdRegistryAddress, IdRegistry.abi, jsonRpcProvider);
    const nameRegistryContract = new Contract(NameRegistryAddress, NameRegistry.abi, jsonRpcProvider);

    const provider = new EthEventsProvider(hub, jsonRpcProvider, idRegistryContract, nameRegistryContract);

    return provider;
  }

  public getLatestBlockNumber(): number {
    return this._lastBlockNumber;
  }

  public async start() {
    // Connect to Ethereum RPC
    await this.connectAndSyncHistoricalEvents();
  }

  public async stop() {
    this._idRegistryContract.removeAllListeners();
    this._nameRegistryContract.removeAllListeners();
    this._jsonRpcProvider.removeAllListeners();

    // Clear all polling, including the bootstrap polling. We need to reach inside the provider to do this,
    // because the provider does not expose a way to stop the bootstrap polling.
    // This can happen if the test runs quickly, where the bootstrap polling is still running when the test ends.
    clearTimeout(this._jsonRpcProvider._bootstrapPoll);
    this._jsonRpcProvider.polling = false;

    // Wait for all async promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Returns expiry for fname in ms from unix epoch */
  public async getFnameExpiry(fname: Uint8Array): HubAsyncResult<number> {
    const encodedFname = bytesToBytes32(fname);
    if (encodedFname.isErr()) {
      return err(encodedFname.error);
    }

    const expiryResult: Result<BigNumber, HubError> = await ResultAsync.fromPromise(
      this._nameRegistryContract['expiryOf'](encodedFname.value),
      (err) => new HubError('unavailable.network_failure', err as Error)
    );

    return expiryResult.map((expiry) => expiry.toNumber() * 1000);
  }

  /* -------------------------------------------------------------------------- */
  /*                               Private Methods                              */
  /* -------------------------------------------------------------------------- */

  /** Connect to Ethereum RPC */
  private async connectAndSyncHistoricalEvents() {
    const latestBlockResult = await ResultAsync.fromPromise(this._jsonRpcProvider.getBlock('latest'), (err) => err);
    if (latestBlockResult.isErr()) {
      log.error(
        { err: latestBlockResult.error },
        'failed to connect to ethereum node. Check your eth RPC URL (e.g. --eth-rpc-url)'
      );
      return;
    }

    const latestBlock = latestBlockResult.value;
    log.info({ latestBlock: latestBlock.number }, 'connected to ethereum node');

    // Find how how much we need to sync
    let lastSyncedBlock = GoerliEthConstants.FirstBlock;

    const hubState = await this._hub.getHubState();
    if (hubState.isOk()) {
      lastSyncedBlock = hubState.value.lastEthBlock;
    }

    log.info({ lastSyncedBlock }, 'last synced block');
    const toBlock = latestBlock.number;

    // Sync old Id events
    await this.syncHistoricalIdEvents(
      protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER,
      lastSyncedBlock,
      toBlock,
      GoerliEthConstants.ChunkSize
    );
    await this.syncHistoricalIdEvents(
      protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_TRANSFER,
      lastSyncedBlock,
      toBlock,
      GoerliEthConstants.ChunkSize
    );

    // Sync old Name Transfer events
    await this.syncHistoricalNameEvents(
      protobufs.NameRegistryEventType.NAME_REGISTRY_EVENT_TYPE_TRANSFER,
      lastSyncedBlock,
      toBlock,
      GoerliEthConstants.ChunkSize
    );

    // We don't need to sync historical Renew events because the expiry
    // is pulled when NameRegistryEvents are merged

    this._isHistoricalSyncDone = true;
  }

  /**
   * Sync old Id events that may have happened before hub was started. We'll put them all
   * in the sync queue to be processed later, to make sure we don't process any unconfirmed events.
   */
  private async syncHistoricalIdEvents(
    type: protobufs.IdRegistryEventType,
    fromBlock: number,
    toBlock: number,
    batchSize: number
  ) {
    const typeString = type === protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER ? 'Register' : 'Transfer';

    /*
     * How querying blocks in batches works
     * We calculate the difference in blocks, for example, lets say we need to sync/cache 769,531 blocks (difference between the contracts FirstBlock, and the latest Goerli block at time of writing, 8418326)
     * After that, we divide our difference in blocks by the batchSize. For example, over 769,531 blocks, at a 10,000 block batchSize, we need to run our loop 76.9531 times, which obviously just rounds up to 77 loops
     * During this whole process, we're using a for(let i=0;) loop, which means to get the correct from block, we need to calculate new fromBlock's and toBlock's on every loop
     * fromBlock: FirstBlock + (loopIndex * batchSize) - Example w/ batchSize 10,000: Run 0 - FirstBlock + 0, Run 1 - FirstBlock + 10,000, Run 2 - FirstBlock + 20,000, etc....
     * toBlock: fromBlock + batchSize - Example w/ batchSize 10,000: Run 0: fromBlock + 10,000, Run 1 - fromBlock + 10,000, etc...
     */

    // Calculate amount of runs required based on batchSize, and round up to capture all blocks
    const numOfRuns = Math.ceil((toBlock - fromBlock) / batchSize);

    for (let i = 0; i < numOfRuns; i++) {
      let nextFromBlock = fromBlock + i * batchSize;
      const nextToBlock = nextFromBlock + batchSize;

      if (i > 0) {
        // If this isn't our first loop, we need to up the fromBlock by 1, or else we will be re-caching an already cached block.
        nextFromBlock += 1;
      }

      // Fetch our batch of blocks
      let batchIdEvents = await ResultAsync.fromPromise(
        this._idRegistryContract.queryFilter(typeString, Number(nextFromBlock), Number(nextToBlock)),
        (e) => e
      );

      // Make sure the batch didn't error, and if it did, retry.
      if (batchIdEvents.isErr()) {
        // Query for the blocks again, in a last ditch effort
        const retryBatchIdEvents = await ResultAsync.fromPromise(
          this._idRegistryContract.queryFilter(typeString, Number(nextFromBlock), Number(nextToBlock)),
          (e) => e
        );

        // If our new query succeeded, update our variable and cache the blocks
        if (retryBatchIdEvents.isOk()) {
          batchIdEvents = retryBatchIdEvents;
        } else {
          // If we still hit an error, just log the error and return
          log.error({ err: batchIdEvents.error }, 'failed to get a batch of old ID events');
          return;
        }
      }

      // Loop through each event, get the right values, and cache it
      for (const event of batchIdEvents.value) {
        const toIndex = type === protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER ? 0 : 1;
        const idIndex = type === protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER ? 1 : 2;

        // Parsing can throw errors, so we'll just log them and continue
        try {
          const to: string = event.args?.at(toIndex);
          const id: BigNumber = BigNumber.from(event.args?.at(idIndex));
          const from: string =
            type === protobufs.IdRegistryEventType.ID_REGISTRY_EVENT_TYPE_REGISTER ? null : event.args?.at(0);

          await this.cacheIdRegistryEvent(from, to, id, type, event);
        } catch (e) {
          log.error({ event }, 'failed to parse event args');
        }
      }
    }
  }

  /**
   * Sync old Name events that may have happened before hub was started. We'll put them all
   * in the sync queue to be processed later, to make sure we don't process any unconfirmed events.
   */
  private async syncHistoricalNameEvents(
    type: protobufs.NameRegistryEventType,
    fromBlock: number,
    toBlock: number,
    batchSize: number
  ) {
    const typeString =
      type === protobufs.NameRegistryEventType.NAME_REGISTRY_EVENT_TYPE_TRANSFER ? 'Transfer' : 'Renew';

    /*
     * Querying Blocks in Batches
     *   
     * 1. Calculate difference between the first and last sync blocks (e.g. )
     * 2. Divide by batch size and round up to get runs, and iterate with for-loop
     * 3. Compute the fromBlock in each run as firstBlock + (loopIndex * batchSize)
     * 4. Compute the toBlock in each run as fromBlock + batchSize
     * 5. In every run after the first one, increment fromBlock by 1 to avoid duplication

     * To sync blocks from 7,648,795 to 8,418,326, the diff is 769,531
     * The run size for a 10k batch would be =  76.9531 ~= 77 runs
     * For the 1st run, fromBlock = 7,648,795 + (0 * 10,000) =  7,648,795
     * For the 1st run, toBlock = 7,648,795 + 10,000 =  7,658,795
     * For the 2nd run, fromBlock = 7,648,795 + (1 * 10,000) + 1 =  7,658,796
     * For the 2nd run, toBlock = 7,658,796 + 10,000 =  7,668,796
     */

    // Calculate amount of runs required based on batchSize, and round up to capture all blocks
    const numOfRuns = Math.ceil((toBlock - fromBlock) / batchSize);

    for (let i = 0; i < numOfRuns; i++) {
      let nextFromBlock = fromBlock + i * batchSize;
      const nextToBlock = nextFromBlock + batchSize;

      if (i > 0) {
        // If this isn't our first loop, we need to up the fromBlock by 1, or else we will be re-caching an already cached block.
        nextFromBlock += 1;
      }

      let oldNameBatchEvents = await ResultAsync.fromPromise(
        this._nameRegistryContract.queryFilter(typeString, Number(nextFromBlock), Number(nextToBlock)),
        (e) => e
      );

      if (oldNameBatchEvents.isErr()) {
        const retryNameBatchEvents = await ResultAsync.fromPromise(
          this._nameRegistryContract.queryFilter(typeString, Number(nextFromBlock), Number(nextToBlock)),
          (e) => e
        );

        // If our new query succeeded, update our variable and cache the blocks
        if (retryNameBatchEvents.isOk()) {
          oldNameBatchEvents = retryNameBatchEvents;
        } else {
          // If we still hit an error, just log the error and return
          log.error({ err: oldNameBatchEvents.error }, 'failed to get old Name events');
          return;
        }
      }

      for (const event of oldNameBatchEvents.value) {
        if (type === protobufs.NameRegistryEventType.NAME_REGISTRY_EVENT_TYPE_TRANSFER) {
          // Handling: use try-catch + log since errors are expected and not importrant to surface
          try {
            const from: string = event.args?.at(0);
            const to: string = event.args?.at(1);
            const tokenId: BigNumber = BigNumber.from(event.args?.at(2));
            await this.cacheNameRegistryEvent(from, to, tokenId, event);
          } catch (e) {
            log.error({ event }, 'failed to parse event args');
          }
        }
      }
    }
  }

  /** Handle a new block. Processes all events in the cache that have now been confirmed */
  private async handleNewBlock(blockNumber: number) {
    log.info({ blockNumber }, `new block: ${blockNumber}`);

    // Get all blocks that have been confirmed into a single array and sort.
    const cachedBlocksSet = new Set([
      ...this._nameEventsByBlock.keys(),
      ...this._idEventsByBlock.keys(),
      ...this._renewEventsByBlock.keys(),
    ]);
    const cachedBlocks = Array.from(cachedBlocksSet);
    cachedBlocks.sort();

    for (const cachedBlock of cachedBlocks) {
      if (cachedBlock + this._numConfirmations <= blockNumber) {
        const idEvents = this._idEventsByBlock.get(cachedBlock);
        this._idEventsByBlock.delete(cachedBlock);

        if (idEvents) {
          for (const idEvent of idEvents) {
            await this._hub.submitIdRegistryEvent(idEvent, 'eth-provider');
          }
        }

        const nameEvents = this._nameEventsByBlock.get(cachedBlock);
        this._nameEventsByBlock.delete(cachedBlock);

        if (nameEvents) {
          for (const nameEvent of nameEvents) {
            await this._hub.submitNameRegistryEvent(nameEvent, 'eth-provider');
          }
        }

        const renewEvents = this._renewEventsByBlock.get(cachedBlock);
        this._renewEventsByBlock.delete(cachedBlock);

        if (renewEvents) {
          for (const renewEvent of renewEvents) {
            const nameRegistryEvent = await this._hub.engine.getNameRegistryEvent(renewEvent.fname);
            if (nameRegistryEvent.isErr()) {
              log.error(
                { blockNumber, errCode: nameRegistryEvent.error.errCode },
                `failed to get event for fname ${bytesToUtf8String(
                  renewEvent.fname
                )._unsafeUnwrap()} from renew event: ${nameRegistryEvent.error.message}`
              );
              continue;
            }

            const updatedEvent: protobufs.NameRegistryEvent = {
              ...nameRegistryEvent.value,
              ...renewEvent,
            };

            await this._hub.submitNameRegistryEvent(updatedEvent);
          }
        }
      }
    }

    // Update the last synced block if all the historical events have been synced
    if (this._isHistoricalSyncDone) {
      const hubState = protobufs.HubState.create({ lastEthBlock: blockNumber });
      await this._hub.putHubState(hubState);
    }

    this._lastBlockNumber = blockNumber;
  }

  private async cacheIdRegistryEvent(
    from: string | null,
    to: string,
    id: BigNumber,
    type: protobufs.IdRegistryEventType,
    event: Event
  ): HubAsyncResult<void> {
    const { blockNumber, blockHash, transactionHash, logIndex } = event;

    const logEvent = log.child({ event: { to, id: id.toString(), blockNumber } });

    const serialized = Result.combine([
      from && from.length > 0 ? hexStringToBytes(from) : ok(new Uint8Array()),
      hexStringToBytes(blockHash),
      hexStringToBytes(transactionHash),
      hexStringToBytes(to),
    ]);

    if (serialized.isErr()) {
      logEvent.error({ errCode: serialized.error.errCode }, `cacheIdRegistryEvent error: ${serialized.error.message}`);
      return err(serialized.error);
    }

    const [fromBytes, blockHashBytes, transactionHashBytes, toBytes] = serialized.value;

    // Construct the protobuf
    const idRegistryEvent = protobufs.IdRegistryEvent.create({
      blockNumber,
      blockHash: blockHashBytes,
      logIndex,
      fid: id.toNumber(),
      to: toBytes,
      transactionHash: transactionHashBytes,
      type,
      from: fromBytes,
    });

    // Add it to the cache
    let idEvents = this._idEventsByBlock.get(blockNumber);
    if (!idEvents) {
      idEvents = [];
      this._idEventsByBlock.set(blockNumber, idEvents);
    }
    idEvents.push(idRegistryEvent);

    log.info(
      { event: { to, id: id.toString(), blockNumber } },
      `cacheIdRegistryEvent: fid ${id.toString()} assigned to ${to} in block ${blockNumber}`
    );

    return ok(undefined);
  }

  private async cacheNameRegistryEvent(
    from: string,
    to: string,
    tokenId: BigNumber,
    event: Event
  ): HubAsyncResult<void> {
    const { blockNumber, blockHash, transactionHash, logIndex } = event;

    const logEvent = log.child({ event: { to, blockNumber } });

    const serialized = Result.combine([
      hexStringToBytes(blockHash),
      hexStringToBytes(transactionHash),
      from && from.length > 0 ? hexStringToBytes(from) : ok(new Uint8Array()),
      hexStringToBytes(to),
      bytes32ToBytes(tokenId),
    ]);

    if (serialized.isErr()) {
      logEvent.error(
        { errCode: serialized.error.errCode },
        `cacheNameRegistryEvent error: ${serialized.error.message}`
      );
      return err(serialized.error);
    }

    const [blockHashBytes, transactionHashBytes, fromBytes, toBytes, fnameBytes] = serialized.value;

    const nameRegistryEvent = protobufs.NameRegistryEvent.create({
      blockNumber,
      blockHash: blockHashBytes,
      transactionHash: transactionHashBytes,
      logIndex,
      fname: fnameBytes,
      from: fromBytes,
      to: toBytes,
      type: protobufs.NameRegistryEventType.NAME_REGISTRY_EVENT_TYPE_TRANSFER,
    });

    // Add it to the cache
    let nameEvents = this._nameEventsByBlock.get(blockNumber);
    if (!nameEvents) {
      nameEvents = [];
      this._nameEventsByBlock.set(blockNumber, nameEvents);
    }
    nameEvents.push(nameRegistryEvent);

    logEvent.info(`cacheNameRegistryEvent: token id ${tokenId.toString()} assigned to ${to} in block ${blockNumber}`);

    return ok(undefined);
  }

  private async cacheRenewEvent(tokenId: BigNumber, expiry: BigNumber, event: Event): HubAsyncResult<void> {
    const { blockHash, transactionHash, blockNumber, logIndex } = event;

    const logEvent = log.child({ event: { blockNumber } });

    const serialized = Result.combine([
      hexStringToBytes(blockHash),
      hexStringToBytes(transactionHash),
      bytes32ToBytes(tokenId),
      toFarcasterTime(expiry.toNumber()),
    ]);

    if (serialized.isErr()) {
      logEvent.error({ errCode: serialized.error.errCode }, `cacheRenewEvent error: ${serialized.error.message}`);
      return err(serialized.error);
    }

    const [blockHashBytes, transactionHashBytes, fnameBytes, farcasterTimeExpiry] = serialized.value;

    const renewEvent: NameRegistryRenewEvent = {
      blockNumber,
      blockHash: blockHashBytes,
      transactionHash: transactionHashBytes,
      logIndex,
      fname: fnameBytes,
      type: protobufs.NameRegistryEventType.NAME_REGISTRY_EVENT_TYPE_RENEW,
      expiry: farcasterTimeExpiry,
    };

    // Add it to the cache
    let renewEvents = this._renewEventsByBlock.get(blockNumber);
    if (!renewEvents) {
      renewEvents = [];
      this._renewEventsByBlock.set(blockNumber, renewEvents);
    }
    renewEvents.push(renewEvent);

    logEvent.info(`cacheRenewEvent: token id ${tokenId.toString()} renewed in block ${blockNumber}`);

    return ok(undefined);
  }
}
