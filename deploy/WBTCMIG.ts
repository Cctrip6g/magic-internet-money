import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { deployments, ethers, getNamedAccounts } from "hardhat";
import { expect } from "chai";
import { DegenBox, IOracle, ProxyOracle } from "../typechain";
import { ChainId, setDeploymentSupportedChains, wrappedDeploy } from "../utilities";
import { Constants, xMerlin } from "../test/constants";

const INTEREST_CONVERSION = 1e18 / (365.25 * 3600 * 24) / 100;
const OPENING_CONVERSION = 1e5 / 100;

const oracleData = "0x0000000000000000000000000000000000000000";

export const ParametersPerChain = {
  
  [ChainId.Mainnet]: {
    enabled: true,
    cauldronV3MC: Constants.mainnet.cauldronV3mig,
    degenBox: Constants.mainnet.degenBox,
    mim: Constants.mainnet.mig,
    owner: xMerlin,

    collateralization: 85 * 1e3, // 75% LTV
    opening: 0.05 * OPENING_CONVERSION, // 0% initial
    interest: parseInt(String(0 * INTEREST_CONVERSION)), // 0% Interest
    liquidation: 7 * 1e3 + 1e5, // 10% liquidation fee

    cauldrons: [
      {
        deploymentNamePrefix: "WBTCMig",
        collateral: Constants.mainnet.wbtc,
      },
    ],
  },
};

const deployFunction: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await getNamedAccounts();
  const chainId = parseInt(await hre.getChainId());
  const parameters = ParametersPerChain[chainId];

  if (!parameters.enabled) {
    console.log(`Deployment disabled for chain id ${chainId}`);
    return;
  }

  const getDeployment = async (name: string) => {
    try {
      return (await deployments.get(name)).address
    } catch {
      return undefined
    }
  }

  const DegenBox = await ethers.getContractAt<DegenBox>("DegenBox", parameters.degenBox);
  const cauldrons = parameters.cauldrons;

  for (let i = 0; i < cauldrons.length; i++) {
    const cauldron = cauldrons[i];

    const ProxyOracle = await wrappedDeploy<ProxyOracle>(`${cauldron.deploymentNamePrefix}ProxyOracle`, {
      from: deployer,
      args: [],
      log: true,
      contract: "ProxyOracle",
      deterministicDeployment: false,
    });

    const Oracle = await wrappedDeploy<IOracle>(`${cauldron.deploymentNamePrefix}OracleV1`, {
      from: deployer,
      args: [],
      log: true,
      contract: "WbtcOracleMig",
      deterministicDeployment: false,
    });

    if ((await ProxyOracle.oracleImplementation()) !== Oracle.address) {
      await (await ProxyOracle.changeOracleImplementation(Oracle.address)).wait();
    }
    if ((await ProxyOracle.owner()) !== xMerlin) {
      await (await ProxyOracle.transferOwnership(xMerlin, true, false)).wait();
    }

    let initData = ethers.utils.defaultAbiCoder.encode(
      ["address", "address", "bytes", "uint64", "uint256", "uint256", "uint256"],
      [
        cauldron.collateral,
        ProxyOracle.address,
        oracleData,
        parameters.interest,
        parameters.liquidation,
        parameters.collateralization,
        parameters.opening,
      ]
    );

    const cauldronAddress = await getDeployment(`${cauldron.deploymentNamePrefix}Cauldron`)

    if(cauldronAddress === undefined) {
        const tx = await (await DegenBox.deploy(parameters.cauldronV3MC, initData, true)).wait();

        const deployEvent = tx?.events?.[0];
        expect(deployEvent?.eventSignature).to.be.eq("LogDeploy(address,bytes,address)");
    
        deployments.save(`${cauldron.deploymentNamePrefix}Cauldron`, {
          abi: [],
          address: deployEvent?.args?.cloneAddress,
        });
    }

    /* // Liquidation Swapper
    await wrappedDeploy(`${cauldron.deploymentNamePrefix}Swapper`, {
        from: deployer,
        log: true,
        contract: "YVCrvStETHSwapper2",
        deterministicDeployment: false,
    });

    // Leverage Swapper
    await wrappedDeploy(`${cauldron.deploymentNamePrefix}LevSwapper`, {
        from: deployer,
        log: true,
        contract: "YVCrvStETHLevSwapper2",
        deterministicDeployment: false,
    });     */  
  }
};

export default deployFunction;

setDeploymentSupportedChains(Object.keys(ParametersPerChain), deployFunction);

deployFunction.tags = ["WBTCMig"];
deployFunction.dependencies = [];
