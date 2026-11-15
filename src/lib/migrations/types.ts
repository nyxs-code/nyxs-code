export interface Migration {
  id: number;
  name: string;
  up(): Promise<void>;
}
