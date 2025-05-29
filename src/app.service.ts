import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  public async bootstrap() {
    console.log('AppService bootstrap');
  }
}
