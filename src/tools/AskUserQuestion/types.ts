export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  question: string;
  answer: string;
}

export type AskUserFn = (questions: AskQuestion[]) => Promise<AskAnswer[] | null>;
