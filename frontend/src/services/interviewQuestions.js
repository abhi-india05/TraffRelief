// Aligned 5-question rehabilitation follow-up interview questions
// Stable IDs: 'q1' through 'q5'

export const INTERVIEW_QUESTIONS = [
  {
    id: 'q1',
    number: 1,
    en: 'How has your energy been lately? For example, have you been feeling rested when you wake up, or more tired than usual?',
    kn: 'ಇತ್ತೀಚೆಗೆ ನಿಮ್ಮ ದೈಹಿಕ ಶಕ್ತಿ ಹೇಗಿದೆ? ಉದಾಹರಣೆಗೆ, ಬೆಳಿಗ್ಗೆ ಎದ್ದಾಗ ಚೆನ್ನಾಗಿ ವಿಶ್ರಾಂತಿ ಪಡೆದಂತೆ ಅನಿಸುತ್ತಿದೆಯೇ, ಅಥವಾ ಸಾಮಾನ್ಯಕ್ಕಿಂತ ಹೆಚ್ಚು ದಣಿವಾಗುತ್ತಿದೆಯೇ?'
  },
  {
    id: 'q2',
    number: 2,
    en: 'What has been taking up most of your attention or focus recently?',
    kn: 'ಇತ್ತೀಚೆಗೆ ನಿಮ್ಮ ಗಮನ ಅಥವಾ ಮನಸ್ಸನ್ನು ಹೆಚ್ಚು ಆವರಿಸಿಕೊಂಡಿರುವ ವಿಷಯ ಯಾವುದು?'
  },
  {
    id: 'q3',
    number: 3,
    en: 'What’s something you’ve done in the last few days that you genuinely enjoyed or found interesting?',
    kn: 'ಕಳೆದ ಕೆಲವು ದಿನಗಳಲ್ಲಿ ನೀವು ನಿಜವಾಗಿಯೂ ಸಂತೋಷಪಟ್ಟ ಅಥವಾ ಆಸಕ್ತಿದಾಯಕವೆಂದು ಕಂಡ ಯಾವುದಾದರೂ ಕೆಲಸವನ್ನು ಮಾಡಿದ್ದೀರಾ?'
  },
  {
    id: 'q4',
    number: 4,
    en: 'What are you looking forward to in the next few days or weeks?',
    kn: 'ಮುಂದಿನ ಕೆಲವು ದಿನಗಳು ಅಥವಾ ವಾರಗಳಲ್ಲಿ ನೀವು ಯಾವುದಕ್ಕಾಗಿ ಎದುರು ನೋಡುತ್ತಿದ್ದೀರಿ?'
  },
  {
    id: 'q5',
    number: 5,
    en: 'How have interactions with other people felt for you recently?',
    kn: 'ಇತ್ತೀಚೆಗೆ ಇತರರೊಂದಿಗೆ ನಿಮ್ಮ ಸಂಬಂಧ ಅಥವಾ ಮಾತುಕತೆ ಹೇಗಿದೆ ಎಂದು ಅನಿಸುತ್ತಿದೆ?'
  }
];

export const QUESTION_MAP = new Map(INTERVIEW_QUESTIONS.map(q => [q.id, q]));
