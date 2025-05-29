import * as Joi from 'joi';

export const validationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  ETH_RPC_URL: Joi.string().required(),
  PRIVATE_KEY: Joi.string().required(),
  UNISWAP_POSITION_MANAGER_ADDRESS: Joi.string().default('0xC36442b4a4522E871399CD717aBDD847Ab11FE88'),
}); 