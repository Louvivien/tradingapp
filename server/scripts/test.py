import string

alpha_to_num = {c: i for i, c in enumerate(string.ascii_letters + string.digits + string.punctuation, start=1)}  

def encode(text):
    for _ in range(50):
        text = ' '.join(str(alpha_to_num[c]) for c in text.upper())
    return text

def decode(text):
    for _ in range(50):
        text = ''.join(num_to_alpha[int(c)] for c in text.split()) 
    return text 

num_to_alpha = {i: c for c, i in alpha_to_num.items()}   

text = 'Hello World!'
encoded = encode(text)
print(encoded)  
# 8 5 12 12 15 15 23 15 18 12 4  23 15 18 12 4 ...

decoded = decode(encoded) 
print(decoded)
# HELLO WORLD! HELLO WORLD! ... 

if __name__ == '__main__':
    user_text = input('Enter text to encode/decode: ')
    user_choice = input('Do you want to (e)ncode or (d)ecode the text? ')
    
    if user_choice == 'e':
        encoded_text = encode(user_text)
        print(f'Encoded text: {encoded_text}')
    elif user_choice == 'd':
        decoded_text = decode(user_text)
        print(f'Decoded text: {decoded_text}')