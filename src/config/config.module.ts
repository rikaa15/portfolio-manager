import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './configuration';
import { validationSchema } from './validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),
  ],
})
export class AppConfigModule {} 