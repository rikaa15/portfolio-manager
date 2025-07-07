import { registerAs } from '@nestjs/config';
import { config as dotenvConfig } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

dotenvConfig({ path: '.env' });

const isDevelopment = process.env.NODE_ENV === 'development';

const config: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  host: process.env.DB_HOST,
  schema: process.env.DB_SCHEMA,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  ssl: isDevelopment
    ? false
    : {
        rejectUnauthorized: (process.env.DB_SSL_ENABLED || 'false') !== 'false',
      },
  entities: ['dist/**/*.entity{.ts,.js}'],
  migrations: ['dist/src/migrations/*{.ts,.js}'],
  synchronize: true,
  // migrationsTableName: 'migrations',
  // migrationsRun: true,
};

export default new DataSource(config);

export const typeormConfig = registerAs('typeorm', () => config);
