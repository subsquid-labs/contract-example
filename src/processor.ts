import {BatchHandlerContext, BatchProcessorItem, EvmBatchProcessor, EvmBlock} from '@subsquid/evm-processor'
import {LogItem} from '@subsquid/evm-processor/lib/interfaces/dataSelection'
import {Store, TypeormDatabase} from '@subsquid/typeorm-store'
import {In} from 'typeorm'
import {Owner, Token, Transfer} from './model'
import {isFunctionResultDecodingError} from './abi/abi.support'

import * as erc721 from './abi/erc721'
import {BigNumber} from 'ethers'

export const CONTRACT_ADDRESS = '0xac5c7493036de60e63eb81c5e9a440b42f47ebf5'

let database = new TypeormDatabase()
let processor = new EvmBatchProcessor()
    .setDataSource({
        archive: 'https://eth.archive.subsquid.io',
        chain: 'https://rpc.ankr.com/eth',
    })
    .setBlockRange({
        from: 15_584_000 ,
    })
    .addLog(CONTRACT_ADDRESS, {
        filter: [[erc721.events.Transfer.topic]],
        data: {
            evmLog: {
                topics: true,
                data: true,
            },
            transaction: {
                hash: true,
            },
        },
    })

type Item = BatchProcessorItem<typeof processor>
type Context = BatchHandlerContext<Store, Item>

processor.run(database, async (ctx) => {
    let transfersData: TransferEventData[] = []

    for (let block of ctx.blocks) {
        for (let item of block.items) {
            if (item.kind !== 'evmLog') continue

            if (item.evmLog.topics[0] === erc721.events.Transfer.topic) {
                transfersData.push(handleTransfer(ctx, block.header, item))
            }
        }
    }

    await saveTransfers(ctx, transfersData)
})

interface TransferEventData {
    id: string
    blockNumber: number
    timestamp: Date
    txHash: string
    from: string
    to: string
    tokenIndex: bigint
}

function handleTransfer(
    ctx: Context,
    block: EvmBlock,
    item: LogItem<{evmLog: {topics: true; data: true}; transaction: {hash: true}}>
): TransferEventData {
    let {from, to, tokenId} = erc721.events.Transfer.decode(item.evmLog)

    let transfer: TransferEventData = {
        id: item.evmLog.id,
        tokenIndex: tokenId.toBigInt(),
        from,
        to,
        timestamp: new Date(block.timestamp),
        blockNumber: block.height,
        txHash: item.transaction.hash,
    }

    return transfer
}

async function saveTransfers(ctx: Context, transfersData: TransferEventData[]) {
    let tokensIds: Set<string> = new Set()
    let ownersIds: Set<string> = new Set()

    for (let transferData of transfersData) {
        tokensIds.add(transferData.tokenIndex.toString())
        ownersIds.add(transferData.from)
        ownersIds.add(transferData.to)
    }

    let transfers: Transfer[] = []

    let tokens = await ctx.store.findBy(Token, {id: In([...tokensIds])}).then((q) => new Map(q.map((i) => [i.id, i])))
    let owners = await ctx.store.findBy(Owner, {id: In([...ownersIds])}).then((q) => new Map(q.map((i) => [i.id, i])))

    for (let transferData of transfersData) {
        let from = owners.get(transferData.from)
        if (from == null) {
            from = new Owner({id: transferData.from})
            owners.set(from.id, from)
        }

        let to = owners.get(transferData.to)
        if (to == null) {
            to = new Owner({id: transferData.to})
            owners.set(to.id, to)
        }

        let tokenId = transferData.tokenIndex.toString()

        let token = tokens.get(tokenId)
        if (token == null) {
            let contract = new erc721.Contract(ctx, {height: transferData.blockNumber}, CONTRACT_ADDRESS)
            token = new Token({
                id: tokenId,
                uri: await contract.tokenURI(BigNumber.from(transferData.tokenIndex)).catch(e => {
                    if (isFunctionResultDecodingError(e)) {
                        return 'unknown'
                    } else {
                        throw e
                    }
                }),
            })
            tokens.set(token.id, token)
        }
        token.owner = to

        let {id, blockNumber, txHash, timestamp} = transferData

        let transfer = new Transfer({
            id,
            blockNumber,
            timestamp,
            txHash,
            from,
            to,
            token,
        })

        transfers.push(transfer)
    }

    await ctx.store.save([...owners.values()])
    await ctx.store.save([...tokens.values()])
    await ctx.store.save(transfers)
}
