import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { Logger } from '@nestjs/common';

describe('AppService', () => {
  let service: AppService;
  let loggerSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    service = module.get<AppService>(AppService);
    
    // Spy on console.log for bootstrap method
    loggerSpy = jest.spyOn(console, 'log');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHello', () => {
    it('should return "Hello World!"', () => {
      expect(service.getHello()).toBe('Hello World!');
    });
  });

  describe('bootstrap', () => {
    it('should log bootstrap message', async () => {
      await service.bootstrap();
      expect(loggerSpy).toHaveBeenCalledWith('AppService bootstrap');
    });
  });
}); 