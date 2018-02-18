import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as jsSHA3 from 'js-sha3';
import * as _ from 'lodash';
import * as Web3 from 'web3';

import { addSourceMapAsync } from './compiler';
import { etherscan } from './etherscan';
import { bytecode, sourceCode, sourceMap } from './exampleData';
import { makeGasCostByPcToLines } from './gasCost';
import { trace } from './trace';
import { GasCostByPcBySignature, TxCountBySignature } from './types';

interface SignatureByHash {
    [sigHash: string]: string;
}

const web3 = new Web3(new Web3.providers.HttpProvider('http://node.web3api.com:8545'));
const web3Wrapper = new Web3Wrapper(web3.currentProvider);

export const handleRequestAsync = async (address: string) => {
    const isContract = await web3Wrapper.doesContractExistAtAddressAsync(address);
    if (!isContract) {
        return {
            error: 'NOT_A_CONTRACT',
        };
    }
    const cacheOnly = false;
    const transactions = await etherscan.smartlyGetTransactionsForAccountAsync(address, 10);
    let abis: Web3.ContractAbi;
    try {
        abis = await etherscan.getContractABIAsync(address);
    } catch (e) {
        return {
            error: 'NO_ABI_FOUND',
        };
    }
    const functionAbis = _.filter(abis, abi => abi.type === 'function');
    const signatureByHash: SignatureByHash = {};
    _.map(functionAbis, (methodAbi: Web3.MethodAbi) => {
        const signature = `${methodAbi.name}(${_.map(
            methodAbi.inputs,
            (input: Web3.FunctionParameter) => input.type,
        ).join(',')})`;
        const sigHash = `0x${jsSHA3.keccak256(signature).substr(0, 8)}`;
        signatureByHash[sigHash] = signature;
    });
    console.log(`Fetched ${transactions.length} transactions`);
    const gasCostByPcBySignature: GasCostByPcBySignature = {};
    const txCountBySignature: TxCountBySignature = {};
    for (const transaction of transactions) {
        let signature: string;
        if (_.isEmpty(transaction.input)) {
            signature = '()';
        }
        const sigHash = transaction.input.substr(0, 10);
        signature = signatureByHash[sigHash];
        if (_.isUndefined(signature)) {
            signature = '()';
        }
        console.log(`Processing https://etherscan.io/tx/${transaction.hash}`);
        const conciseTxTrace = await trace.getTransactionConciseTraceAsync(transaction.hash, cacheOnly);
        const txGasCostByPc = trace.getGasCostByPcFromConciseTxTrace(conciseTxTrace);
        gasCostByPcBySignature['*'] = trace.combineGasCostByPc(gasCostByPcBySignature['*'], txGasCostByPc);
        txCountBySignature['*'] = (txCountBySignature['*'] || 0) + 1;
        gasCostByPcBySignature[signature] = trace.combineGasCostByPc(gasCostByPcBySignature[signature], txGasCostByPc);
        txCountBySignature[signature] = (txCountBySignature[signature] || 0) + 1;
    }
    const contractMetadata = await addSourceMapAsync(await etherscan.getContractInfoAsync(address));
    const gasCostByPcToLines = makeGasCostByPcToLines(contractMetadata);
    const gasCostByLineBySignature = _.mapValues(gasCostByPcBySignature, gasCostByPcToLines);
    const contractMetadataToReturn = contractMetadata;
    delete contractMetadataToReturn.bytecode;
    delete contractMetadataToReturn.sourcemap;
    const responseData = {
        ...contractMetadataToReturn,
        txCountBySignature,
        gasCostByLineBySignature,
    };
    return responseData;
};
